import http.server
import socketserver

PORT = 5173

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        if self.path == "/sw.js" or self.path.startswith("/sw.js?"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

print(f"Serving on http://localhost:{PORT}")
socketserver.TCPServer(("", PORT), Handler).serve_forever()
