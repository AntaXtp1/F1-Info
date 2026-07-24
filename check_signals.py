import json
import urllib.request
import ssl

def check_streams():
    # Load JSON file
    path = 'C:/Users/ThinkPad/Downloads/sniffer-v4-1784896479235.json'
    try:
      with open(path, 'r') as f:
          data = json.load(f)
    except Exception as e:
      print(f"Error loading JSON: {e}")
      return

    streams = data.get('streams', [])
    print(f"Checking {len(streams)} streams...\n")

    # Disable SSL verification for testing
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    results = []
    for url in streams:
        # Skip local/about/dornatoken if not reachable
        if '127.0.0.1' in url or 'localhost' in url or 'about:blank' in url:
            continue
            
        req = urllib.request.Request(
            url, 
            headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36'}
        )
        status = "FAILED"
        cors = "NO"
        content_type = ""
        
        try:
            with urllib.request.urlopen(req, context=ctx, timeout=5) as response:
                status = response.status
                headers = response.info()
                cors = headers.get('Access-Control-Allow-Origin', 'NONE')
                content_type = headers.get('Content-Type', '')
        except Exception as e:
            status = f"ERROR ({str(e)[:50]})"

        results.append({
            'url': url,
            'status': status,
            'cors': cors,
            'type': content_type
        })
        print(f"URL: {url[:60]}... -> Status: {status} | CORS: {cors} | Type: {content_type}")

    # Output filtered working streams
    print("\n=== WORKING STREAMS (HTTP 200) ===")
    working = [r for r in results if r['status'] == 200 or 'HTTP Error 404' not in str(r['status'])]
    for w in working:
        print(f"URL: {w['url']}\nStatus: {w['status']} | CORS: {w['cors']} | Type: {w['type']}\n")

if __name__ == '__main__':
    check_streams()
