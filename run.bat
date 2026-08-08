@echo off
echo ============================================
echo  AI Classroom Monitor - Startup
echo ============================================

cd /d "%~dp0"

:: Check if venv exists
if not exist "venv" (
    echo Creating virtual environment...
    python -m venv venv
)

:: Activate venv
call venv\Scripts\activate.bat

:: Install dependencies
echo Installing dependencies...
pip install -r requirements.txt --quiet

:: Download face-api models if missing
if not exist "models\tiny_face_detector_model-weights_manifest.json" (
    echo Downloading face-api.js models...
    python download_models.py
)

:: Start server
echo.
echo ============================================
echo  Server starting at http://localhost:8000
echo  Open this URL in your browser to begin
echo ============================================
echo.
python main.py
pause
