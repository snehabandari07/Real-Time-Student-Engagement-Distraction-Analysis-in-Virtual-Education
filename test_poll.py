import asyncio
import websockets
import json

async def test_poll():
    # Must wait a bit in the background so both connect
    class_id = "testclass123"
    
    async def student():
        uri = f"ws://localhost:8000/ws/student/{class_id}/s123"
        async with websockets.connect(uri) as websocket:
            await websocket.send(json.dumps({"type": "info", "name": "Student A"}))
            while True:
                resp = await websocket.recv()
                data = json.loads(resp)
                if data.get("type") == "start_poll":
                    print(f"Student received poll: {data}")
                    return

    async def teacher():
        uri = f"ws://localhost:8000/ws/teacher/{class_id}"
        async with websockets.connect(uri) as websocket:
            # Teacher connects, class created
            await asyncio.sleep(1) # Let student join
            # Teacher admits student
            await websocket.send(json.dumps({"command": "admit", "student_id": "s123", "name": "Student A"}))
            await asyncio.sleep(1)
            # Send poll
            poll_msg = {
                "command": "start_poll",
                "questions": [{"id": "1", "text": "Q1?", "options": {"A": "A", "B": "B", "C": "C", "D": "D"}, "correct": "A"}]
            }
            print("Teacher sending poll...")
            await websocket.send(json.dumps(poll_msg))
            await asyncio.sleep(2)

    await asyncio.gather(student(), teacher())

asyncio.run(test_poll())
