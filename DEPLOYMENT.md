# Deployment Guide - EC2 with Domain ai.byuisresearch.com

## Prerequisites
- EC2 instance running Ubuntu 22.04 or similar
- Domain `ai.byuisresearch.com` pointing to your EC2 IP address
- SSH access to your EC2 instance
- OpenAI API key

---

## Step 1: Initial Server Setup

### 1.1 SSH into your EC2 instance
```bash
ssh -i your-key.pem ubuntu@ai.byuisresearch.com
```

### 1.2 Update system packages
```bash
sudo apt update
sudo apt upgrade -y
```

### 1.3 Install Node.js (v20.x)
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version  # Should show v20.x
npm --version
```

### 1.4 Install PostgreSQL
```bash
sudo apt install -y postgresql postgresql-contrib
sudo systemctl start postgresql
sudo systemctl enable postgresql
```

### 1.5 Install Nginx
```bash
sudo apt install -y nginx
sudo systemctl start nginx
sudo systemctl enable nginx
```

### 1.6 Install Certbot for SSL
```bash
sudo apt install -y certbot python3-certbot-nginx
```

### 1.7 Install PM2 (Process Manager)
```bash
sudo npm install -g pm2
```

---

## Step 2: Database Setup

### 2.1 Create PostgreSQL database and user
```bash
sudo -u postgres psql
```

In PostgreSQL prompt:
```sql
CREATE DATABASE ai_therapist;
CREATE USER therapist_admin WITH PASSWORD 'your_secure_password_here';
GRANT ALL PRIVILEGES ON DATABASE ai_therapist TO therapist_admin;
\c ai_therapist
GRANT ALL ON SCHEMA public TO therapist_admin;
\q
```

### 2.2 Configure PostgreSQL for local connections
Edit pg_hba.conf:
```bash
sudo nano /etc/postgresql/14/main/pg_hba.conf
```

Add this line before other rules:
```
local   ai_therapist    therapist_admin                  md5
```

Restart PostgreSQL:
```bash
sudo systemctl restart postgresql
```

---

## Step 3: Deploy Application Code

### 3.1 Clone or upload your code
```bash
cd /home/ubuntu
git clone <your-repo-url> ai-therapist
# OR use scp to copy files from local machine:
# scp -i your-key.pem -r /path/to/Ai-therapist ubuntu@ai.byuisresearch.com:/home/ubuntu/
cd ai-therapist
```

### 3.2 Install dependencies
```bash
npm install
```

### 3.3 Create production .env file
```bash
nano .env
```

Add these variables:
```env
# Server
NODE_ENV=production
PORT=3000

# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=ai_therapist
DB_USER=therapist_admin
DB_PASSWORD=your_secure_password_here

# Session
SESSION_SECRET=generate_a_very_long_random_string_here_at_least_64_chars

# OpenAI
OPENAI_API_KEY=your_openai_api_key_here

# CORS (for production)
CORS_ORIGIN=https://ai.byuisresearch.com
```

Generate a secure session secret:
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

### 3.4 Run database migrations
```bash
# Apply all migrations in order
psql -U therapist_admin -d ai_therapist -f src/database/migrations/001_create_users_table.sql
psql -U therapist_admin -d ai_therapist -f src/database/migrations/002_add_ended_by_column.sql
psql -U therapist_admin -d ai_therapist -f src/database/migrations/003_normalize_schema.sql
psql -U therapist_admin -d ai_therapist -f src/database/migrations/004_add_session_config.sql
psql -U therapist_admin -d ai_therapist -f src/database/migrations/005_create_conversation_logs.sql
psql -U therapist_admin -d ai_therapist -f src/database/migrations/006_create_messages_table.sql
psql -U therapist_admin -d ai_therapist -f src/database/migrations/007_create_system_config.sql
psql -U therapist_admin -d ai_therapist -f src/database/migrations/008_add_rate_limit_indexes.sql
psql -U therapist_admin -d ai_therapist -f src/database/migrations/009_add_output_modalities.sql
psql -U therapist_admin -d ai_therapist -f src/database/migrations/010_fix_timestamp_columns.sql
```

### 3.5 Build the production bundles
```bash
npm run build
```

---

## Step 4: Configure Nginx as Reverse Proxy

### 4.1 Create Nginx configuration
```bash
sudo nano /etc/nginx/sites-available/ai-therapist
```

Use the configuration from `nginx.conf` file (created separately).

### 4.2 Enable the site
```bash
sudo ln -s /etc/nginx/sites-available/ai-therapist /etc/nginx/sites-enabled/
sudo nginx -t  # Test configuration
sudo systemctl reload nginx
```

---

## Step 5: Setup SSL Certificate

### 5.1 Obtain SSL certificate with Certbot
```bash
sudo certbot --nginx -d ai.byuisresearch.com
```

Follow the prompts:
- Enter your email address
- Agree to terms of service
- Choose whether to redirect HTTP to HTTPS (recommended: Yes)

### 5.2 Auto-renewal setup
Certbot automatically sets up renewal. Test it:
```bash
sudo certbot renew --dry-run
```

---

## Step 6: Start Application with PM2

### 6.1 Start the app
```bash
cd /home/ubuntu/ai-therapist
pm2 start ecosystem.config.cjs
```

### 6.2 Save PM2 process list
```bash
pm2 save
```

### 6.3 Setup PM2 to start on boot
```bash
pm2 startup
# Copy and run the command it outputs
```

### 6.4 Monitor the application
```bash
pm2 status
pm2 logs ai-therapist
pm2 monit
```

---

## Step 7: Configure Firewall

### 7.1 Setup UFW (Ubuntu Firewall)
```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

### 7.2 Ensure EC2 Security Group allows:
- Port 22 (SSH) - Your IP only
- Port 80 (HTTP)
- Port 443 (HTTPS)
- Port 5432 (PostgreSQL) - Only if needed for remote access

---

## Step 8: Create Initial Admin User

### 8.1 Connect to database
```bash
psql -U therapist_admin -d ai_therapist
```

### 8.2 Create admin user
```sql
INSERT INTO users (username, password, role)
VALUES ('admin', '$2b$10$YourHashedPasswordHere', 'researcher');
```

To generate a password hash:
```bash
node -e "const bcrypt = require('bcrypt'); bcrypt.hash('your_password', 10, (e,h) => console.log(h));"
```

Or use the application's registration endpoint once it's running.

---

## Step 9: Verify Deployment

### 9.1 Check services
```bash
pm2 status
sudo systemctl status nginx
sudo systemctl status postgresql
```

### 9.2 Test the application
- Visit: https://ai.byuisresearch.com
- Check SSL certificate is valid
- Test login functionality
- Start a test session

### 9.3 Monitor logs
```bash
pm2 logs ai-therapist --lines 100
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log
```

---

## Useful Commands

### PM2 Management
```bash
pm2 restart ai-therapist   # Restart app
pm2 stop ai-therapist      # Stop app
pm2 delete ai-therapist    # Remove from PM2
pm2 logs ai-therapist      # View logs
pm2 flush                  # Clear logs
```

### Update Application
```bash
cd /home/ubuntu/ai-therapist
git pull origin main
npm install
npm run build
pm2 restart ai-therapist
```

### Database Backup
```bash
pg_dump -U therapist_admin ai_therapist > backup_$(date +%Y%m%d).sql
```

### Database Restore
```bash
psql -U therapist_admin ai_therapist < backup_20260103.sql
```

---

## Troubleshooting

### Check application logs
```bash
pm2 logs ai-therapist
```

### Check Nginx logs
```bash
sudo tail -f /var/log/nginx/error.log
```

### Check if port 3000 is in use
```bash
sudo lsof -i :3000
```

### Restart all services
```bash
pm2 restart all
sudo systemctl restart nginx
sudo systemctl restart postgresql
```

### Test database connection
```bash
psql -U therapist_admin -d ai_therapist -c "SELECT version();"
```

---

## Security Checklist

- [ ] SSL certificate installed and auto-renewal configured
- [ ] Firewall configured (UFW)
- [ ] EC2 Security Groups properly configured
- [ ] Strong passwords for database and admin accounts
- [ ] SESSION_SECRET is long and random
- [ ] Database password is secure
- [ ] SSH key-based authentication only (no password login)
- [ ] Regular backups scheduled
- [ ] Monitoring and alerting setup
- [ ] Log rotation configured

---

## Maintenance

### Weekly
- Check logs for errors
- Monitor disk space
- Review user activity

### Monthly
- Update system packages
- Backup database
- Review SSL certificate expiry
- Check for security updates

### Quarterly
- Update Node.js and npm packages
- Review and update dependencies
- Security audit
