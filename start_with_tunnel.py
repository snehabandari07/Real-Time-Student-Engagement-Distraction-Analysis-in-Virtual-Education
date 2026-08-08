"""
start_with_tunnel.py
Starts main.py + Cloudflare tunnel and prints the public HTTPS URL for students.
Run: python start_with_tunnel.py
"""
import subprocess
import re
import time
import sys
import os

# Fix Windows console encoding for emoji output
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

CF_EXE = r"c:\Users\banda\OneDrive\Desktop\mini project(DL)\cloudflared.exe"


def start_server():
    """Start FastAPI server in background."""
    subprocess.Popen([sys.executable, "main.py"],
                     cwd=os.path.dirname(os.path.abspath(__file__)))


def start_tunnel():
    """Start Cloudflare tunnel and extract public URL."""
    print("\n[*] Starting Cloudflare tunnel... (takes ~10 seconds)")
    proc = subprocess.Popen(
        [CF_EXE, "tunnel", "--url", "http://localhost:8000"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding='utf-8', errors='replace'
    )
    found_url = None
    for line in proc.stdout:
        m = re.search(r'https://[\w\-]+\.trycloudflare\.com', line)
        if m:
            found_url = m.group(0)
            break

    if found_url:
        print("\n" + "="*60)
        print("  [OK] PUBLIC URL (share this with students):")
        print(f"\n  -->  {found_url}")
        print(f"\n  Teacher: {found_url}/")
        print(f"  Student: {found_url}/student?class_id=<CLASS_ID>")
        print("="*60)
        print("\nServer running. Press Ctrl+C to stop.\n")
        # Save for reference
        with open("public_url.txt", "w") as f:
            f.write(found_url)
    else:
        print("[ERROR] Could not get tunnel URL. Check cloudflared.exe path.")

    proc.wait()


if __name__ == "__main__":
    print("[*] Starting AI Classroom Monitor with public access...")
    # Start server
    start_server()
    time.sleep(2)  # Wait for server to bind
    # Start tunnel (blocks until killed)
    start_tunnel()
