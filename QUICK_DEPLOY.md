# Quick Deployment Guide

Deploy AI Therapist to EC2 with domain **ai.byuisresearch.com** in ~30 minutes.

## Prerequisites
- [ ] EC2 instance (Ubuntu 22.04) with SSH access
- [ ] Domain `ai.byuisresearch.com` pointing to EC2 IP
- [ ] OpenAI API key
- [ ] SSH key for EC2 access

---

## Quick Start (3 Steps)

### Step 1: Initial Server Setup (Run once on fresh EC2)

```bash
# SSH into EC2
ssh -i your-key.pem ubuntu@ai.byuisresearch.com

# Download and run setup script
curl -o setup-server.sh https://raw.githubusercontent.com/your-repo/ai-therapist/main/setup-server.sh
sudo bash setup-server.sh
```

Or manually:
```bash
# Copy setup-server.sh to EC2
scp -i ~/Desktop/nathangaskinbackend.pem setup-server.sh ubuntu@ai.byuisresearch.com:/home/ubuntu/

# SSH in and run
ssh -i your-key.pem ubuntu@ai.byuisresearch.com
sudo bash setup-server.sh
```

### Step 2: Deploy Application

```bash
# Upload code to EC2
scp -i ~/Desktop/nathangaskinbackend.pem -r /Users/nathanblatter/Desktop/Ai-therapist ubuntu@ai.byuisresearch.com:/home/ubuntu/

# Or clone from git
ssh -i your-key.pem ubuntu@ai.byuisresearch.com
cd /home/ubuntu
git clone https://github.com/nathanzbl/Ai-therapist.git ai-therapist
cd ai-therapist
```

### Step 3: Configure and Start

```bash
# 1. Create .env file
cp .env.example .env
nano .env
# Fill in: DB_PASSWORD, SESSION_SECRET, OPENAI_API_KEY

# 2. Change database password
sudo -u postgres psql
# Run: ALTER USER therapist_admin PASSWORD 'your_secure_password';

# 3. Setup Nginx
sudo cp nginx.conf /etc/nginx/sites-available/ai-therapist
sudo ln -s /etc/nginx/sites-available/ai-therapist /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx

# 4. Get SSL certificate
sudo certbot --nginx -d ai.byuisresearch.com

# 5. Run migrations
for f in src/database/migrations/*.sql; do
    psql -U therapist_admin -d ai_therapist -f $f
done

# 6. Build and start
npm install
npm run build
pm2 start ecosystem.config.cjs --env production
pm2 save
pm2 startup  # Follow the instructions shown
```

### Step 4: Create Admin User

```bash
# Generate password hash
node -e "const bcrypt = require('bcrypt'); bcrypt.hash('your_admin_password', 10, (e,h) => console.log(h));"

# Insert into database
psql -U therapist_admin -d ai_therapist
# Run: INSERT INTO users (username, password, role) VALUES ('admin', '<hash_from_above>', 'researcher');
```

---

## Verify Deployment

1. Visit: https://ai.byuisresearch.com
2. Login with admin credentials
3. Check logs: `pm2 logs ai-therapist`
4. Check status: `pm2 status`

---

## Future Updates

After initial setup, use the deployment script:

```bash
cd /home/ubuntu/ai-therapist
git pull origin main
./deploy.sh production
```

Or manually:
```bash
git pull
npm install
npm run build
pm2 restart ai-therapist
```

---

## Troubleshooting

### App won't start
```bash
pm2 logs ai-therapist  # Check logs
pm2 restart ai-therapist
```

### Database connection issues
```bash
# Test connection
psql -U therapist_admin -d ai_therapist -c "SELECT version();"

# Check .env file has correct DB_PASSWORD
cat .env | grep DB_
```

### SSL certificate issues
```bash
sudo certbot renew --dry-run
sudo certbot certificates
```

### Nginx issues
```bash
sudo nginx -t  # Test configuration
sudo systemctl status nginx
sudo tail -f /var/log/nginx/error.log
```

---

## Useful Commands

```bash
# PM2
pm2 status                  # Check status
pm2 logs ai-therapist       # View logs
pm2 restart ai-therapist    # Restart app
pm2 monit                   # Monitor resources

# Database
pg_dump -U therapist_admin ai_therapist > backup.sql  # Backup
psql -U therapist_admin ai_therapist < backup.sql     # Restore

# Nginx
sudo systemctl reload nginx    # Reload config
sudo systemctl status nginx    # Check status

# System
df -h                       # Check disk space
free -h                     # Check memory
htop                        # Monitor processes
```

---

## Files Created

- `DEPLOYMENT.md` - Full deployment guide
- `nginx.conf` - Nginx configuration
- `ecosystem.config.cjs` - PM2 configuration
- `deploy.sh` - Deployment automation script
- `setup-server.sh` - Initial server setup script
- `.env.example` - Environment variables template

---

## Support

- Logs: `/home/ubuntu/ai-therapist/logs/`
- Backups: `/home/ubuntu/backups/`
- Nginx logs: `/var/log/nginx/ai-therapist-*.log`

For issues, check `DEPLOYMENT.md` for detailed troubleshooting.
