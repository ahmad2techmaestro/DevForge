#!/bin/sh
# Writes the runtime config so one image works for any API URL.
cat > /usr/share/nginx/html/config.js <<JS
window.__DEVFORGE__ = { apiUrl: "${PUBLIC_API_URL:-http://localhost:4000}" };
JS
