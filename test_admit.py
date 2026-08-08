import asyncio
import websockets
import json
import uuid

async def test_flow():
    class_id = str(uuid.uuid4())[:8]
    student_id = "S123"

    print(f"Testing class: {class_id}")
    
    # Connect teacher
    async with websockets.connect(f"ws://localhost:8000/ws/teacher/{class_id}") as ws_teacher:
        print("Teacher connected")
        
        # Connect student
        async def student_task():
            async with websockets.connect(f"ws://localhost:8000/ws/student/{class_id}/{student_id}") as ws_student:
                print("Student connected")
                await ws_student.send(json.dumps({"type": "info", "name": "Test Student", "student_id": student_id}))
                
                print("Student waiting for messages...")
                while True:
                    msg = await ws_student.recv()
                    print(f"Student received: {msg}")
                    if json.loads(msg).get("type") == "admitted":
                        break
        
        task = asyncio.create_task(student_task())
        
        # Teacher receive
        msg1 = await ws_teacher.recv()
        print(f"Teacher received: {msg1}")
        
        # Teacher receives second join request with actual name?
        msg2 = await ws_teacher.recv()
        print(f"Teacher received: {msg2}")
        
        # Admit student
        print("Teacher admitting student...")
        await ws_teacher.send(json.dumps({"command": "admit", "student_id": student_id}))
        
        msg3 = await ws_teacher.recv()
        print(f"Teacher received: {msg3}")
        
        await task

if __name__ == "__main__":
    asyncio.run(test_flow())
