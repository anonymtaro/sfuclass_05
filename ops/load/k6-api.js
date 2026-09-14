# ops/nginx/classroom.conf
# Single-node fallback only (docker-compose.prod.yml) — production traffic
# normally never touches this; alb.tf's ALB + WAF handles TLS/WS there.
# This exists purely for a DR scratch environment or local prod-parity testing.

upstream classroom_api {
    server api:4000;
}

upstream classroom_realtime {
    server realtime:4000;
}

map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    server_name _;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name _;

    ssl_certificate     /etc/nginx/tls/fullchain.pem;
    ssl_certificate_key /etc/nginx/tls/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    client_max_body_size 0; # uploads go direct-to-S3 via presigned URLs, not through here

    # REST API
    location /api/ {
        proxy_pass http://classroom_api/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }

    # Socket.IO: chat, presence, community, Yjs collab — upgraded connection,
    # long idle timeout above the client heartbeat interval (alb.tf mirrors
    # this with idle_timeout = 90 in the real ALB).
    location /socket.io/ {
        proxy_pass http://classroom_realtime;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 90s;
        proxy_send_timeout 90s;
    }

    location /healthz {
        proxy_pass http://classroom_api/healthz;
        access_log off;
    }
}