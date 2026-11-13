# ShreePay: Cloudflare Pages (frontend) + VPS (backend)

Hostnames (use your own domain; all three must share ONE registrable domain):
- app.example.com  -> Cloudflare Pages (React)
- api.example.com  -> VPS (Express API)
- pay.example.com  -> VPS (same backend; customer payment pages)

## 1. DNS (Cloudflare)
- A `api`  -> VPS IP
- A `pay`  -> VPS IP
- `app` is created automatically when you add the custom domain to the Pages project.
(Orange-cloud proxy is fine; SSL/TLS mode "Full (strict)".)

## 2. VPS (Ubuntu 22.04+)
```bash
sudo apt update && sudo apt install -y nginx redis-server certbot python3-certbot-nginx git ufw
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs
sudo npm i -g pm2

# firewall: only SSH + web. Redis/Postgres are never exposed.
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw enable
# Redis: keep it on localhost (default) and set a password in /etc/redis/redis.conf: requirepass <long-random>
sudo systemctl restart redis-server
```

## 3. Backend
```bash
sudo mkdir -p /var/www/shreepay && sudo chown $USER /var/www/shreepay
# upload the project's backend folder to /var/www/shreepay/backend (git clone or scp)
cd /var/www/shreepay/backend
nano .env          # see "Production .env" below
npm ci
npm run build                 # prisma generate + tsc
npx prisma migrate deploy     # uses the migrations folder (commit prisma/migrations from your dev machine)
npm run create-admin:prod     # once; then delete ADMIN_PASSWORD from .env
pm2 start ../deploy/ecosystem.config.cjs   # or copy it next to the app
pm2 save && pm2 startup       # run the command it prints
```

## 4. Nginx + HTTPS
```bash
sudo cp deploy/nginx-shreepay.conf /etc/nginx/sites-available/shreepay   # edit example.com
sudo ln -s /etc/nginx/sites-available/shreepay /etc/nginx/sites-enabled/
sudo certbot --nginx -d api.example.com -d pay.example.com
sudo nginx -t && sudo systemctl reload nginx
curl https://api.example.com/health
```

## 5. Production .env (backend)
```
NODE_ENV=production
PORT=4000
DATABASE_URL=...                       # direct Neon URL (no -pooler), sslmode=require
FRONTEND_URL=https://app.example.com
BACKEND_URL=https://api.example.com
PAYMENT_PAGE_BASE_URL=https://pay.example.com
TRUST_PROXY=1                          # nginx. Use 2 if Cloudflare orange-cloud also sits in front of the VPS
REDIS_URL=redis://:YOUR_REDIS_PASSWORD@127.0.0.1:6379
SESSION_SECRET / COOKIE_SECRET / JWT_SECRET = 3 different random strings
SMTP_*  = production mail provider (Gmail caps ~500/day)
UPSTREAM_PAYMENT_API_URL=...
ADMIN_ALLOWED_IPS=your.home.ip         # optional but recommended
```

## 6. Frontend on Cloudflare Pages
Pages -> Create project -> connect the Git repo (or upload `frontend/dist`).
- Root directory: `frontend`
- Build command: `npm ci && npm run build`
- Output directory: `dist`
- Environment variables: `VITE_API_URL=https://api.example.com`, `NODE_VERSION=20`
- Custom domain: `app.example.com`
`frontend/public/_redirects` (SPA routing) and `_headers` (security headers, set `connect-src` to your API) are already included.

## 7. Updating later
```bash
cd /var/www/shreepay/backend && git pull && npm ci && npm run build && npx prisma migrate deploy && pm2 reload shreepay-api
```
Frontend redeploys automatically on git push.

## Checklist
- Register at https://app.example.com, OTP mail arrives, login works (cookie `__Host-sp_session`).
- Create a payment: link starts with https://pay.example.com/pay/SP...
- Pay: status flips to VERIFIED by itself.
- `https://api.example.com/pay/...` returns 404 and `https://pay.example.com/auth/me` returns 404 (host split).
