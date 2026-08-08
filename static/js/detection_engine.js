/**
 * detection_engine.js
 * Dual-model engagement detection:
 *   • MediaPipe Face Mesh → geometric features (gaze, head pose, brow furrow, AU4)
 *   • face-api.js CNN     → expression recognition (happy, sad, angry, surprised…)
 * Combined for final classification via weighted scoring.
 *
 * v5 — Brow Furrow (Req1), AU4 Sim (Req2), 15-frame Temporal Smoothing (Req3),
 *       Head Tilt Z-axis bonus (Req4), 5-second Calibration Phase.
 */

const STATE_CONCENTRATED = "CONCENTRATED";
const STATE_CONFUSED = "CONFUSED";
const STATE_DISTRACTED = "DISTRACTED";
const STATE_DROWSY = "DROWSY";
const STATE_NO_FACE = "no_face";

// ══════════════════════════════════════════
//  Thresholds
// ══════════════════════════════════════════
const GAZE_OFF_THRESHOLD = 0.28;
const HEAD_YAW_THRESHOLD = 22;
const HEAD_PITCH_THRESHOLD = 18;
const DISTRACTION_MS = 3000;
const SQUINT_THRESHOLD = 0.018;
const HEAD_TILT_THRESHOLD = 12;    // legacy (general distraction use)
const FRAME_INTERVAL_MS = 66;    // ~15fps for MediaPipe
const CNN_INTERVAL_MS = 400;   // ~2.5fps for face-api CNN

// ── Upgrade constants (v6 — improved frown sensitivity) ──
const SMOOTHING_WINDOW = 8;     // rolling buffer frames (reduced for faster response)
const CALIBRATION_MS = 5000;   // 5-second calibration phase
const BROW_FURROW_DROP = 0.07; // 7% horizontal compression → furrowed (was 15%)
const AU4_THRESHOLD = 0.055;   // brow-to-eye vertical gap threshold (wider range)
const CONFUSED_SUSTAINED_MS = 800;   // sustain before Yellow Alert (was 1500ms)
const HEAD_TILT_CONF_MIN = 5;  // lower tilt angle that adds confusion score
const HEAD_TILT_CONF_MAX = 15; // upper tilt angle for confusion bonus
const BROW_HEIGHT_DROP = 0.06; // 6% vertical drop from baseline → brows lowered toward eyes

// ── Drowsiness detection constants ──
const EAR_DROWSY_THRESHOLD = 0.24;   // EAR below this = eyes nearly closed (relaxed from 0.21)
const MAR_YAWN_THRESHOLD = 0.42;     // MAR above this = mouth wide open (yawn, relaxed from 0.55)
const DROWSY_EAR_SUSTAINED_MS = 1200; // eyes must stay closed for 1.2s (was 2s)
const DROWSY_YAWN_SUSTAINED_MS = 1000; // yawn must sustain for 1s (was 1.5s)
const DROWSY_COMBINED_MS = 800;       // both signals together = faster trigger
const SLOW_BLINK_WINDOW_MS = 10000;   // window for counting slow blinks
const SLOW_BLINK_MIN_DURATION_MS = 250; // minimum closure duration for a "slow blink"
const SLOW_BLINK_COUNT_THRESHOLD = 3;   // 3+ slow blinks in window = drowsy

// ── Landmark indices ──
const LM = {
    LEFT_IRIS: 468, RIGHT_IRIS: 473,
    L_EYE_INNER: 133, L_EYE_OUTER: 33, R_EYE_INNER: 362, R_EYE_OUTER: 263,
    L_EYE_TOP: 159, L_EYE_BOTTOM: 145, R_EYE_TOP: 386, R_EYE_BOTTOM: 374,
    // Original brow landmarks (kept for browLidGap legacy metric)
    L_BROW_INNER: 107, R_BROW_INNER: 336, L_BROW_MID: 105, R_BROW_MID: 334,
    L_UPPER_LID: 159, R_UPPER_LID: 386,
    NOSE_TIP: 1, CHIN: 152, L_CHEEK: 234, R_CHEEK: 454, FOREHEAD: 10,
    L_MOUTH: 61, R_MOUTH: 291, UPPER_LIP: 13, LOWER_LIP: 14,

    // ── Brow landmarks for furrow & height detection ──
    L_BROW_INNER_70: 70,    // left inner brow (horizontal furrow)
    R_BROW_INNER_107: 107,  // right inner brow (horizontal furrow)
    L_BROW_MID_65: 65,      // left mid-brow (extra furrow check)
    R_BROW_MID_295: 295,    // right mid-brow (extra furrow check)
    AU4_BROW_52: 52,        // inner eyebrow top for AU4 brow lowering
    L_BROW_OUTER_63: 63,    // left outer brow (height drop)
    R_BROW_OUTER_293: 293,  // right outer brow (height drop)
    // Eye centre reuses LEFT_IRIS (468), RIGHT_IRIS (473)
};

// ── CNN expression → engagement mapping ──
const EXPR_CONCENTRATED = ["neutral", "happy"];
const EXPR_CONFUSED = ["sad", "angry", "fearful", "disgusted", "surprised"];

class EngagementDetector {
    constructor() {
        this.currentState = STATE_CONCENTRATED;
        this.gazeOffStartTime = null;
        this.onStateChange = null;
        this._running = false;
        this._processing = false;
        this._lastFrameTime = 0;
        this._lastCNNTime = 0;
        this._stateBuffer = [];
        this._confirmedState = STATE_CONCENTRATED;
        this._debugInfo = {};
        this._cnnExpression = "neutral";
        this._cnnConfidence = 0;
        this._cnnReady = false;
        this.blinkPhase = 0;

        // Session tracking
        this._sessionActive = false;
        this._stateHistory = [];       // {state, timestamp}
        this.onSessionEnd = null;     // callback(summaryData)

        // ── Calibration state ──
        this._calibrating = true;
        this._calibrationBrowSamples = [];   // horizontal inter-brow distances
        this._calibrationBrowHeightSamples = []; // vertical brow-to-eye distances
        this._calibrationEARSamples = [];    // EAR samples for drowsy baseline
        this._baselineBrowDist = null;       // median horizontal baseline
        this._baselineBrowHeight = null;     // median vertical brow height baseline
        this._baselineEAR = null;            // median EAR baseline

        // ── NEW: Temporal gate for CONFUSED (Req 3 — 1.5s sustain) ──
        this._confusedCandidateStart = null;

        // ── Temporal gates for DROWSY ──
        this._drowsyEARStart = null;         // when EAR first dropped below threshold
        this._drowsyYawnStart = null;        // when MAR first exceeded yawn threshold
        this._drowsyCombinedStart = null;    // when both EAR+MAR trigger simultaneously

        // ── Slow blink tracking for DROWSY ──
        this._slowBlinks = [];               // timestamps of completed slow blinks
        this._currentBlinkStart = null;      // when current eye closure started
        this._wasEyesClosed = false;         // previous frame eye state

        // ── Toast callback (set from outside, or use internal default) ──
        this._toastFn = null;
    }

    // ══════════════════════════════════════════
    //  Public: set a toast function from the page
    // ══════════════════════════════════════════
    setToastFn(fn) { this._toastFn = fn; }
    _toast(msg) { if (this._toastFn) this._toastFn(msg); }

    async initialize(videoEl, canvasEl, sessionDurationMs = 120000) {
        this.videoElement = videoEl;
        this.canvasElement = canvasEl;
        this.canvasCtx = canvasEl.getContext("2d");
        this._sessionDuration = sessionDurationMs;
        this._sessionStart = Date.now();
        this._sessionActive = true;
        this._stateHistory = [];

        // Ensure video is playing
        if (videoEl.paused) {
            try { await videoEl.play(); } catch(e) {}
        }

        // ── MediaPipe Face Mesh ──
        this.faceMesh = new FaceMesh({
            locateFile: (file) =>
                `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`,
        });
        this.faceMesh.setOptions({
            maxNumFaces: 1,
            refineLandmarks: true,      // required for iris (LM 468) tracking
            minDetectionConfidence: 0.5,
            minTrackingConfidence: 0.5,
        });
        this.faceMesh.onResults((r) => this._onResults(r));

        // ── face-api.js CNN models ──
        const MODEL_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.14/model/";
        await Promise.all([
            faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
            faceapi.nets.faceExpressionNet.loadFromUri(MODEL_URL),
        ]);
        this._cnnReady = true;

        // ── NEW: Calibration timer — ends after CALIBRATION_MS ──
        // Shows a pulsing "CALIBRATING" overlay on canvas during this window.
        // After it completes, compute the median baseline brow distance.
        setTimeout(() => {
            const median = arr => {
                if (!arr.length) return null;
                const s = [...arr].sort((a, b) => a - b);
                const m = Math.floor(s.length / 2);
                return s.length % 2 !== 0 ? s[m] : (s[m - 1] + s[m]) / 2;
            };

            this._baselineBrowDist = median(this._calibrationBrowSamples);
            this._baselineBrowHeight = median(this._calibrationBrowHeightSamples);
            this._baselineEAR = median(this._calibrationEARSamples);

            if (this._baselineBrowDist) {
                console.log(`[Calibration] Baseline brow dist: ${this._baselineBrowDist.toFixed(4)}, height: ${this._baselineBrowHeight?.toFixed(4)}, EAR: ${this._baselineEAR?.toFixed(4)}`);
            } else {
                console.warn("[Calibration] No brow samples captured. Brow detection disabled.");
            }
            this._calibrating = false;
            this._toast("✅ Baseline captured — monitoring active");
        }, CALIBRATION_MS);

        // ── Start loop ──
        this._running = true;
        this._loop();
    }

    async _loop() {
        if (!this._running) return;

        const now = performance.now();

        // MediaPipe frame (~15fps)
        if (now - this._lastFrameTime >= FRAME_INTERVAL_MS) {
            if (!this._processing && this.videoElement.readyState >= 2) {
                this._processing = true;
                this._lastFrameTime = now;
                try {
                    await this.faceMesh.send({ image: this.videoElement });
                } catch (e) {
                    const ctx = this.canvasCtx;
                    const c = this.canvasElement;
                    ctx.drawImage(this.videoElement, 0, 0, c.width, c.height);
                    this._drawOverlay(ctx, c);
                }
                this._processing = false;
            }
        }

        // CNN expression (~2.5fps — heavier model)
        if (this._cnnReady && now - this._lastCNNTime >= CNN_INTERVAL_MS) {
            this._lastCNNTime = now;
            this._runCNN();
        }

        requestAnimationFrame(() => this._loop());
    }

    async _runCNN() {
        try {
            const detection = await faceapi
                .detectSingleFace(this.videoElement, new faceapi.TinyFaceDetectorOptions({ inputSize: 224 }))
                .withFaceExpressions();
            if (detection && detection.expressions) {
                const exprs = detection.expressions;
                let best = "neutral", bestVal = 0;
                for (const [expr, val] of Object.entries(exprs)) {
                    if (val > bestVal) { best = expr; bestVal = val; }
                }
                this._cnnExpression = best;
                this._cnnConfidence = bestVal;
            }
        } catch (e) {
            // CNN error — fall back to geometry only
        }
    }

    // ══════════════════════════════════════════
    _onResults(results) {
        const ctx = this.canvasCtx;
        const canvas = this.canvasElement;
        ctx.save();
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(results.image, 0, 0, canvas.width, canvas.height);

        if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
            const lm = results.multiFaceLandmarks[0];
            this._drawFacePoints(ctx, lm, canvas);

            const gaze = this._gazeRatio(lm);
            const browGap = this._browLidGap(lm);        // legacy metric kept
            const eyeAR = this._eyeAspectRatio(lm);
            const headPose = this._headPose(lm);
            const headTilt = this._headTilt(lm);
            const mouthOpen = this._mouthOpenRatio(lm);

            // ── Feature extractions ──
            const interBrowDist = this._interBrowDist(lm);   // horizontal furrow
            const au4Gap = this._au4BrowLowering(lm);        // AU4 brow lowering
            const browHeightDrop = this._browHeightDrop(lm); // vertical brow-eye gap

            this._debugInfo = {
                gaze, browGap, eyeAR, headPose, headTilt,
                mouthOpen, interBrowDist, au4Gap, browHeightDrop
            };

            const rawState = this._classify(gaze, browGap, eyeAR, headPose,
                headTilt, mouthOpen,
                interBrowDist, au4Gap, browHeightDrop, lm);
            this._pushState(rawState);
        } else {
            this._handleNoFace();
        }

        this._drawOverlay(ctx, canvas);
        this._drawDebugBar(ctx, canvas);
        this._drawTimerBar(ctx, canvas);
        if (this._calibrating) this._drawCalibrationOverlay(ctx, canvas);
        ctx.restore();
    }

    // ══════════════════════════════════════════
    //  Feature extraction (MediaPipe geometric)
    // ══════════════════════════════════════════
    _gazeRatio(lm) {
        const calc = (iris, inner, outer) => {
            const eyeW = this._d(lm[inner], lm[outer]);
            if (eyeW === 0) return 0;
            return this._d(lm[iris], this._mid(lm[inner], lm[outer])) / eyeW;
        };
        return (calc(LM.LEFT_IRIS, LM.L_EYE_INNER, LM.L_EYE_OUTER) +
            calc(LM.RIGHT_IRIS, LM.R_EYE_INNER, LM.R_EYE_OUTER)) / 2;
    }

    _browLidGap(lm) {
        const faceH = this._d(lm[LM.FOREHEAD], lm[LM.CHIN]);
        if (faceH === 0) return 1;
        const li = this._d(lm[LM.L_BROW_INNER], lm[LM.L_UPPER_LID]);
        const ri = this._d(lm[LM.R_BROW_INNER], lm[LM.R_UPPER_LID]);
        const lm2 = this._d(lm[LM.L_BROW_MID], lm[LM.L_UPPER_LID]);
        const rm = this._d(lm[LM.R_BROW_MID], lm[LM.R_UPPER_LID]);
        return ((li + ri + lm2 + rm) / 4) / faceH;
    }

    _eyeAspectRatio(lm) {
        const ear = (top, bot, inn, out) => {
            const v = this._d(lm[top], lm[bot]);
            const h = this._d(lm[inn], lm[out]);
            return h > 0 ? v / h : 0;
        };
        return (ear(LM.L_EYE_TOP, LM.L_EYE_BOTTOM, LM.L_EYE_INNER, LM.L_EYE_OUTER) +
            ear(LM.R_EYE_TOP, LM.R_EYE_BOTTOM, LM.R_EYE_INNER, LM.R_EYE_OUTER)) / 2;
    }

    _headPose(lm) {
        const n = lm[LM.NOSE_TIP], lc = lm[LM.L_CHEEK], rc = lm[LM.R_CHEEK];
        const ld = this._d(n, lc), rd = this._d(n, rc), t = ld + rd;
        const yaw = t > 0 ? ((ld - rd) / t) * 90 : 0;
        const fn = this._d(lm[LM.FOREHEAD], n), nc = this._d(n, lm[LM.CHIN]);
        const pitch = (fn + nc) > 0 ? ((fn - nc) / (fn + nc)) * 90 : 0;
        return { yaw: Math.abs(yaw), pitch: Math.abs(pitch) };
    }

    _headTilt(lm) {
        const l = lm[LM.L_EYE_OUTER], r = lm[LM.R_EYE_OUTER];
        return Math.abs(Math.atan2(r.y - l.y, r.x - l.x) * (180 / Math.PI));
    }

    _mouthOpenRatio(lm) {
        const h = this._d(lm[LM.UPPER_LIP], lm[LM.LOWER_LIP]);
        const w = this._d(lm[LM.L_MOUTH], lm[LM.R_MOUTH]);
        return w > 0 ? h / w : 0;
    }

    // ── Brow Furrow: horizontal proximity of inner brows (LM70 ↔ LM107) ──
    // Also checks mid-brow points (LM65 ↔ LM295) for robustness.
    _interBrowDist(lm) {
        const faceW = this._d(lm[LM.L_CHEEK], lm[LM.R_CHEEK]);
        if (faceW === 0) return 1;
        const inner = this._d(lm[LM.L_BROW_INNER_70], lm[LM.R_BROW_INNER_107]) / faceW;
        const mid = this._d(lm[LM.L_BROW_MID_65], lm[LM.R_BROW_MID_295]) / faceW;
        return (inner + mid) / 2; // average of two brow-pair distances
    }

    // ── AU4 Brow Lowering: vertical gap between inner brow top and iris ──
    _au4BrowLowering(lm) {
        const faceH = this._d(lm[LM.FOREHEAD], lm[LM.CHIN]);
        if (faceH === 0) return 1;
        const leftGap = this._d(lm[LM.AU4_BROW_52], lm[LM.LEFT_IRIS]) / faceH;
        const rightGap = this._d(lm[55], lm[LM.RIGHT_IRIS]) / faceH; // symmetric
        return (leftGap + rightGap) / 2;
    }

    // ── Brow Height Drop: how close brows are to the eyes (vertical) ──
    // Uses outer+inner brow points vs. eye-top landmarks. When brows lower
    // during a frown/concern, this ratio shrinks below the calibrated baseline.
    _browHeightDrop(lm) {
        const faceH = this._d(lm[LM.FOREHEAD], lm[LM.CHIN]);
        if (faceH === 0) return 1;
        const lGap = this._d(lm[LM.L_BROW_INNER_70], lm[LM.L_EYE_TOP]) / faceH;
        const rGap = this._d(lm[LM.R_BROW_INNER_107], lm[LM.R_EYE_TOP]) / faceH;
        return (lGap + rGap) / 2;
    }

    // ══════════════════════════════════════════
    //  Combined classification (Geometry + CNN)
    //  Upgraded: Reqs 1–4 integrated
    // ══════════════════════════════════════════
    _classify(gaze, browGap, eyeAR, headPose, headTilt, mouthOpen,
        interBrowDist, au4Gap, browHeightDrop, lm) {
        const now = Date.now();

        // ── Step 1: DISTRACTED — gaze away or head turned for >3s ──
        const headTurned = headPose.yaw > HEAD_YAW_THRESHOLD || headPose.pitch > HEAD_PITCH_THRESHOLD;
        const gazeAway = gaze > GAZE_OFF_THRESHOLD;

        if (headTurned || gazeAway) {
            if (!this.gazeOffStartTime) this.gazeOffStartTime = now;
            if (now - this.gazeOffStartTime >= DISTRACTION_MS) {
                this._confusedCandidateStart = null;
                return STATE_DISTRACTED;
            }
        } else {
            this.gazeOffStartTime = null;
        }

        // ── Step 2: During calibration — collect brow + EAR samples ──
        if (this._calibrating) {
            if (interBrowDist > 0) this._calibrationBrowSamples.push(interBrowDist);
            if (browHeightDrop > 0) this._calibrationBrowHeightSamples.push(browHeightDrop);
            if (eyeAR > 0) this._calibrationEARSamples.push(eyeAR);
            return STATE_CONCENTRATED;
        }

        // ── Step 3: Brow Furrow — horizontal compression of inner brows ──
        let browFurrow = false;
        if (this._baselineBrowDist !== null && interBrowDist > 0) {
            const drop = (this._baselineBrowDist - interBrowDist) / this._baselineBrowDist;
            browFurrow = drop > BROW_FURROW_DROP; // >7% narrowing = frowning
        }

        // ── Step 4: Brow Height Drop — brows descending toward eyes ──
        let browLowered = false;
        if (this._baselineBrowHeight !== null && browHeightDrop > 0) {
            const drop = (this._baselineBrowHeight - browHeightDrop) / this._baselineBrowHeight;
            browLowered = drop > BROW_HEIGHT_DROP; // >6% vertical drop = lowered brows
        }

        // ── Step 5: AU4 Brow Lowering ──
        const au4Active = au4Gap < AU4_THRESHOLD;

        // ── Step 5.5: DROWSY detection (EAR drop + yawn + slow blinks) ──
        const earThreshold = this._baselineEAR
            ? Math.min(EAR_DROWSY_THRESHOLD, this._baselineEAR * 0.78)
            : EAR_DROWSY_THRESHOLD;

        const eyesClosed = eyeAR < earThreshold;
        const yawning = mouthOpen > MAR_YAWN_THRESHOLD;

        // ── Slow blink tracking ──
        if (eyesClosed) {
            if (!this._currentBlinkStart) this._currentBlinkStart = now;
        } else {
            // Eyes just opened — check if the closure was a "slow blink"
            if (this._currentBlinkStart) {
                const blinkDuration = now - this._currentBlinkStart;
                if (blinkDuration >= SLOW_BLINK_MIN_DURATION_MS) {
                    this._slowBlinks.push(now);
                }
                this._currentBlinkStart = null;
            }
        }
        // Prune old blinks outside the window
        this._slowBlinks = this._slowBlinks.filter(t => now - t < SLOW_BLINK_WINDOW_MS);

        // Slow blink pattern → drowsy
        if (this._slowBlinks.length >= SLOW_BLINK_COUNT_THRESHOLD) {
            this._confusedCandidateStart = null;
            this._slowBlinks = []; // reset after triggering
            return STATE_DROWSY;
        }

        // ── Combined signal: low EAR + open mouth simultaneously ──
        const partialEyeDroop = eyeAR < (earThreshold * 1.15); // slightly relaxed for combined
        const partialYawn = mouthOpen > (MAR_YAWN_THRESHOLD * 0.85);
        if (partialEyeDroop && partialYawn) {
            if (!this._drowsyCombinedStart) this._drowsyCombinedStart = now;
            if (now - this._drowsyCombinedStart >= DROWSY_COMBINED_MS) {
                this._confusedCandidateStart = null;
                return STATE_DROWSY;
            }
        } else {
            this._drowsyCombinedStart = null;
        }

        // EAR sustained gate (single signal)
        if (eyesClosed) {
            if (!this._drowsyEARStart) this._drowsyEARStart = now;
            if (now - this._drowsyEARStart >= DROWSY_EAR_SUSTAINED_MS) {
                this._confusedCandidateStart = null;
                return STATE_DROWSY;
            }
        } else {
            this._drowsyEARStart = null;
        }

        // MAR yawn sustained gate (single signal)
        if (yawning) {
            if (!this._drowsyYawnStart) this._drowsyYawnStart = now;
            if (now - this._drowsyYawnStart >= DROWSY_YAWN_SUSTAINED_MS) {
                this._confusedCandidateStart = null;
                return STATE_DROWSY;
            }
        } else {
            this._drowsyYawnStart = null;
        }

        // ── Step 6: Confusion score — Multi-signal approach ──
        // Brow + CNN expression + head tilt + squint for robust detection
        let confScore = 0;

        if (browFurrow) confScore += 3;  // inner brows squeezing together (horizontal)
        if (browLowered) confScore += 3;  // brows dropping toward eyes (vertical)
        if (au4Active) confScore += 2;  // AU4 anatomical brow lowering

        // CNN expression bonus for confusion-correlated expressions
        if (EXPR_CONFUSED.includes(this._cnnExpression) && this._cnnConfidence > 0.4) {
            confScore += 2;
        }

        // Head tilt bonus (tilted head = thinking/confused gesture)
        if (headTilt > HEAD_TILT_CONF_MIN && headTilt < HEAD_TILT_CONF_MAX) {
            confScore += 1;
        }

        // Squint bonus (narrowed eyes while looking at screen = struggling)
        if (eyeAR < 0.22 && eyeAR > earThreshold) {
            confScore += 1;
        }

        // ── Step 7: Candidate gate — only needs score ≥ 2 now ──
        const isConfusedCandidate = confScore >= 2;

        // ── Step 8: Temporal gate — sustain 800ms to prevent flicker ──
        if (isConfusedCandidate) {
            if (!this._confusedCandidateStart) this._confusedCandidateStart = now;
            if (now - this._confusedCandidateStart >= CONFUSED_SUSTAINED_MS) {
                return STATE_CONFUSED;
            }
            return this._confirmedState; // hold current state while building up
        } else {
            this._confusedCandidateStart = null;
        }

        // ── Step 9: Default — CONCENTRATED ──
        return STATE_CONCENTRATED;
    }

    _handleNoFace() {
        const now = Date.now();
        if (!this.gazeOffStartTime) this.gazeOffStartTime = now;
        if (now - this.gazeOffStartTime >= DISTRACTION_MS) {
            this._pushState(STATE_NO_FACE);
        }
    }

    // ══════════════════════════════════════════
    //  Temporal smoothing — priority-weighted rolling vote
    // ══════════════════════════════════════════
    _pushState(rawState) {
        this._stateBuffer.push(rawState);
        if (this._stateBuffer.length > SMOOTHING_WINDOW) this._stateBuffer.shift();

        // Record in session history
        if (this._sessionActive) {
            this._stateHistory.push({ state: rawState, ts: Date.now() });
        }

        // Priority-weighted voting: DROWSY and DISTRACTED get 1.5x weight
        // so they don't get suppressed by CONCENTRATED majority
        const PRIORITY_WEIGHT = { DROWSY: 1.5, DISTRACTED: 1.5, [STATE_NO_FACE]: 1.5, CONFUSED: 1.3, CONCENTRATED: 1.0 };
        const scores = {};
        for (const s of this._stateBuffer) {
            const w = PRIORITY_WEIGHT[s] || 1.0;
            scores[s] = (scores[s] || 0) + w;
        }

        let best = rawState, bestC = 0;
        for (const [s, c] of Object.entries(scores)) {
            if (c > bestC) { bestC = c; best = s; }
        }

        if (best !== this._confirmedState) {
            this._confirmedState = best;
            this.currentState = best;
            if (this.onStateChange) this.onStateChange(best);
        }
    }

    // ══════════════════════════════════════════
    //  Session management
    // ══════════════════════════════════════════
    _endSession() {
        this._sessionActive = false;
        this._running = false;

        if (this.videoElement && this.videoElement.srcObject) {
            this.videoElement.srcObject.getTracks().forEach(t => t.stop());
        }

        const summary = this._buildSummary();
        if (this.onSessionEnd) this.onSessionEnd(summary);
    }

    _buildSummary() {
        const hist = this._stateHistory;
        if (hist.length === 0) return { concentrated: 0, confused: 0, distracted: 0, drowsy: 0, no_face: 0, total: 0, timeline: [] };

        let counts = { CONCENTRATED: 0, CONFUSED: 0, DISTRACTED: 0, DROWSY: 0, no_face: 0 };
        for (const h of hist) {
            if (counts[h.state] !== undefined) counts[h.state]++;
        }
        const total = hist.length;

        // Build 10-second timeline buckets
        const bucketMs = 10000;
        const timeline = [];
        const start = hist[0].ts;
        let bucketStart = start;
        let bucketCounts = { CONCENTRATED: 0, CONFUSED: 0, DISTRACTED: 0, DROWSY: 0, no_face: 0 };
        let bucketTotal = 0;

        for (const h of hist) {
            if (h.ts - bucketStart >= bucketMs) {
                timeline.push({
                    time: Math.round((bucketStart - start) / 1000),
                    dominant: this._dominant(bucketCounts),
                    ...this._pcts(bucketCounts, bucketTotal),
                });
                bucketStart += bucketMs;
                bucketCounts = { CONCENTRATED: 0, CONFUSED: 0, DISTRACTED: 0, DROWSY: 0, no_face: 0 };
                bucketTotal = 0;
            }
            if (bucketCounts[h.state] !== undefined) bucketCounts[h.state]++;
            bucketTotal++;
        }
        if (bucketTotal > 0) {
            timeline.push({
                time: Math.round((bucketStart - start) / 1000),
                dominant: this._dominant(bucketCounts),
                ...this._pcts(bucketCounts, bucketTotal),
            });
        }

        return {
            concentrated: Math.round((counts.CONCENTRATED / total) * 100),
            confused: Math.round((counts.CONFUSED / total) * 100),
            distracted: Math.round((counts.DISTRACTED / total) * 100),
            drowsy: Math.round((counts.DROWSY / total) * 100),
            no_face: Math.round((counts.no_face / total) * 100),
            total,
            duration: Math.round((hist[hist.length - 1].ts - hist[0].ts) / 1000),
            timeline,
        };
    }

    _dominant(counts) {
        let best = "CONCENTRATED", bestC = 0;
        for (const [s, c] of Object.entries(counts)) { if (c > bestC) { bestC = c; best = s; } }
        return best;
    }
    _pcts(counts, total) {
        if (total === 0) return { c: 0, f: 0, d: 0, dr: 0, nf: 0 };
        return {
            c: Math.round((counts.CONCENTRATED / total) * 100),
            f: Math.round((counts.CONFUSED / total) * 100),
            d: Math.round((counts.DISTRACTED / total) * 100),
            dr: Math.round((counts.DROWSY / total) * 100),
            nf: Math.round((counts.no_face / total) * 100),
        };
    }

    getElapsedMs() { return Date.now() - this._sessionStart; }
    getRemainingMs() { return Math.max(0, this._sessionDuration - this.getElapsedMs()); }
    getState() { return this.currentState; }

    // ══════════════════════════════════════════
    //  Drawing
    // ══════════════════════════════════════════
    _drawFacePoints(ctx, lm, canvas) {
        const pts = [
            LM.NOSE_TIP, LM.CHIN, LM.L_CHEEK, LM.R_CHEEK, LM.FOREHEAD,
            LM.L_EYE_INNER, LM.L_EYE_OUTER, LM.R_EYE_INNER, LM.R_EYE_OUTER,
            LM.LEFT_IRIS, LM.RIGHT_IRIS,
            LM.L_BROW_INNER, LM.R_BROW_INNER, LM.L_BROW_MID, LM.R_BROW_MID,
            LM.L_EYE_TOP, LM.L_EYE_BOTTOM,
            LM.R_EYE_TOP, LM.R_EYE_BOTTOM,
            LM.L_MOUTH, LM.R_MOUTH, LM.UPPER_LIP, LM.LOWER_LIP,
            // Highlight the new upgrade landmarks
            LM.L_BROW_INNER_70, LM.AU4_BROW_52,
        ];
        ctx.fillStyle = "rgba(0, 255, 200, 0.5)";
        for (const i of pts) {
            const p = lm[i];
            ctx.beginPath();
            ctx.arc(p.x * canvas.width, p.y * canvas.height, 2.5, 0, 2 * Math.PI);
            ctx.fill();
        }

        // Draw the inter-brow furrow line (LM70 ↔ LM107) for visual debug
        const p70 = lm[LM.L_BROW_INNER_70];
        const p107 = lm[LM.R_BROW_INNER_107];
        ctx.strokeStyle = this._calibrating ? "rgba(255,200,0,0.6)" : "rgba(255,80,80,0.7)";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(p70.x * canvas.width, p70.y * canvas.height);
        ctx.lineTo(p107.x * canvas.width, p107.y * canvas.height);
        ctx.stroke();
        ctx.setLineDash([]);
    }

    // ── NEW: Calibration phase overlay ──
    _drawCalibrationOverlay(ctx, canvas) {
        const elapsed = Date.now() - this._sessionStart;
        const progress = Math.min(elapsed / CALIBRATION_MS, 1);
        const secs = Math.ceil((CALIBRATION_MS - elapsed) / 1000);

        // Semi-transparent amber banner
        ctx.fillStyle = "rgba(241, 196, 15, 0.18)";
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Top banner
        ctx.fillStyle = "rgba(30, 20, 0, 0.7)";
        ctx.fillRect(0, 0, canvas.width, 50);

        ctx.font = "bold 17px 'Inter', sans-serif";
        ctx.textAlign = "center";
        ctx.fillStyle = "rgba(255, 210, 50, 0.95)";
        ctx.fillText(`⚙️  CALIBRATING — Sit neutral… ${secs}s`, canvas.width / 2, 32);

        // Progress bar
        const barY = 46, barH = 4;
        ctx.fillStyle = "rgba(255,255,255,0.12)";
        ctx.fillRect(0, barY, canvas.width, barH);
        ctx.fillStyle = "rgba(241, 196, 15, 0.85)";
        ctx.fillRect(0, barY, canvas.width * progress, barH);
    }

    _drawOverlay(ctx, canvas) {
        this.blinkPhase += 0.06;
        const alpha = 0.22 + 0.22 * Math.sin(this.blinkPhase * Math.PI);
        const cols = {
            [STATE_CONCENTRATED]: [46, 204, 113],
            [STATE_CONFUSED]: [241, 196, 15],
            [STATE_DISTRACTED]: [231, 76, 60],
            [STATE_DROWSY]: [230, 126, 34],
            [STATE_NO_FACE]: [139, 92, 246],
        };
        const [r, g, b] = cols[this.currentState] || cols[STATE_CONCENTRATED];
        const col = `rgba(${r},${g},${b},${alpha})`;

        // Border strips
        ctx.fillStyle = col;
        ctx.fillRect(0, 0, canvas.width, 5);
        ctx.fillRect(0, canvas.height - 5, canvas.width, 5);
        ctx.fillRect(0, 0, 5, canvas.height);
        ctx.fillRect(canvas.width - 5, 0, 5, canvas.height);

        // Corner accents
        const cl = 40;
        ctx.strokeStyle = `rgba(${r},${g},${b},${alpha + 0.2})`;
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(0, cl); ctx.lineTo(0, 0); ctx.lineTo(cl, 0); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(canvas.width - cl, 0); ctx.lineTo(canvas.width, 0); ctx.lineTo(canvas.width, cl); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, canvas.height - cl); ctx.lineTo(0, canvas.height); ctx.lineTo(cl, canvas.height); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(canvas.width - cl, canvas.height); ctx.lineTo(canvas.width, canvas.height); ctx.lineTo(canvas.width, canvas.height - cl); ctx.stroke();

        // State label pill (skip during calibration — that overlay handles it)
        if (!this._calibrating) {
            const la = 0.7 + 0.25 * Math.sin(this.blinkPhase * Math.PI);
            const txt = this.currentState;
            ctx.font = "bold 16px 'Inter', sans-serif";
            const tw = ctx.measureText(txt).width;
            ctx.fillStyle = "rgba(0,0,0,0.5)";
            ctx.beginPath(); ctx.roundRect(canvas.width / 2 - tw / 2 - 12, 10, tw + 24, 28, 14); ctx.fill();
            ctx.fillStyle = `rgba(${r},${g},${b},${la})`;
            ctx.textAlign = "center";
            ctx.fillText(txt, canvas.width / 2, 30);
        }

        // CNN expression badge
        if (this._cnnReady && this._cnnExpression) {
            ctx.font = "12px 'Inter', sans-serif";
            ctx.fillStyle = "rgba(255,255,255,0.5)";
            ctx.textAlign = "right";
            ctx.fillText(`CNN: ${this._cnnExpression} (${(this._cnnConfidence * 100).toFixed(0)}%)`, canvas.width - 10, 52);
        }
    }

    _drawDebugBar(ctx, canvas) {
        const d = this._debugInfo;
        if (!d.gaze) return;

        // ── Line 1: classic metrics ──
        const browPct = (this._baselineBrowDist && d.interBrowDist)
            ? (((this._baselineBrowDist - d.interBrowDist) / this._baselineBrowDist) * 100).toFixed(1)
            : "—";
        const calLabel = this._calibrating ? "CAL" : "ON";

        ctx.font = "11px 'Inter', monospace";
        ctx.textAlign = "left";
        ctx.fillStyle = "rgba(255,255,255,0.45)";
        ctx.fillText(
            `Gaze:${d.gaze.toFixed(3)}  Brow:${d.browGap.toFixed(3)}  EAR:${d.eyeAR.toFixed(3)}  ` +
            `Yaw:${d.headPose.yaw.toFixed(1)}°  Tilt:${d.headTilt.toFixed(1)}°`,
            8, canvas.height - 22
        );

        // ── Line 2: new upgrade metrics ──
        ctx.fillStyle = "rgba(255,220,80,0.55)";
        const heightPct = (this._baselineBrowHeight && d.browHeightDrop)
            ? (((this._baselineBrowHeight - d.browHeightDrop) / this._baselineBrowHeight) * 100).toFixed(1)
            : "—";
        ctx.fillText(
            `BrowFurrow%:${browPct}  BrowDrop%:${heightPct}  AU4:${d.au4Gap ? d.au4Gap.toFixed(3) : "—"}  ` +
            `EAR:${d.eyeAR ? d.eyeAR.toFixed(3) : "—"}  MAR:${d.mouthOpen ? d.mouthOpen.toFixed(3) : "—"}  ` +
            `Cal:${calLabel}  Buf:${this._stateBuffer.length}/${SMOOTHING_WINDOW}`,
            8, canvas.height - 8
        );
    }

    _drawTimerBar(ctx, canvas) {
        const elapsed = this.getElapsedMs();
        const pct = Math.min(elapsed / this._sessionDuration, 1);

        const barH = 4;
        const y = canvas.height - barH;
        ctx.fillStyle = "rgba(255,255,255,0.1)";
        ctx.fillRect(0, y, canvas.width, barH);
        ctx.fillStyle = pct < 0.8 ? "rgba(59,130,246,0.7)" : "rgba(231,76,60,0.8)";
        ctx.fillRect(0, y, canvas.width * pct, barH);
    }

    _d(a, b) { return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2); }
    _mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

    stop() {
        this._running = false;
        this._sessionActive = false;
        if (this.videoElement && this.videoElement.srcObject) {
            this.videoElement.srcObject.getTracks().forEach(t => t.stop());
        }
    }
}
