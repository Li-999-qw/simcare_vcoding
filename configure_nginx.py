import ssl,fnmatch
from pathlib import Path
ROOT=Path(__file__).resolve().parent
cert=ROOT/'certs/server.pem';key=ROOT/'certs/server-key.pem'
context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);context.load_cert_chain(cert,key)
info=ssl._ssl._test_decode_cert(str(cert))
if not any(kind=='DNS' and (name=='www.simcare.top' or name=='*.simcare.top') for kind,name in info.get('subjectAltName',[])):raise SystemExit('Certificate must cover www.simcare.top')
import time
if ssl.cert_time_to_seconds(info['notAfter'])<=time.time():raise SystemExit('Certificate has expired')
text='''worker_processes 1;
events { worker_connections 1024; }
http {
 include mime.types;
 default_type application/octet-stream;
 sendfile on;
 server { listen 80; server_name www.simcare.top; return 308 https://www.simcare.top$request_uri; }
 server {
  listen 443 ssl;
  server_name www.simcare.top;
  ssl_certificate "CERT";
  ssl_certificate_key "KEY";
  ssl_protocols TLSv1.2 TLSv1.3;
  root "FRONT";
  charset utf-8;
  client_max_body_size 12m;
  add_header X-Content-Type-Options nosniff always;
  location = / { return 302 /portal.html; }
  location ~ ^/(?:en/)?training/[^/]+/$ {
   proxy_pass http://127.0.0.1:28876;
   proxy_set_header Host $http_host;
   proxy_set_header X-Forwarded-Proto $scheme;
   proxy_set_header X-Forwarded-For $remote_addr;
   add_header Cache-Control no-store;
  }
  location /ui/ { return 404; }
  location = /admin/models { try_files /models.html =404; }
  location = /admin/bailian { try_files /bailian.html =404; }
  location / { try_files $uri @api; add_header Cache-Control no-store; }
  location @api {
   proxy_pass http://127.0.0.1:28876;
   proxy_set_header Host $http_host;
   proxy_set_header X-Forwarded-Proto $scheme;
   proxy_set_header X-Forwarded-For $remote_addr;
   proxy_buffering off;
   proxy_read_timeout 150s;
  }
 }
}
'''.replace('CERT',cert.as_posix()).replace('KEY',key.as_posix()).replace('FRONT',(ROOT/'frontend').as_posix())
(ROOT/'nginx/conf/nginx.conf').write_text(text,encoding='utf-8')
print('Certificate matches key and domain; Nginx configuration generated')
