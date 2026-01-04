#!/bin/bash

# Initial Server Setup Script for AI Therapist on EC2
# Run this script ONCE on a fresh Ubuntu EC2 instance
# Usage: sudo bash setup-server.sh

set -e

echo "🔧 AI Therapist - Initial Server Setup"
echo "======================================"
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo "Please run as root (use sudo)"
    exit 1
fi

# Update system
echo "📦 Updating system packages..."
apt update
apt upgrade -y

# Install Node.js 20.x
echo "📦 Installing Node.js 20.x..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
node --version
npm --version

# Install PostgreSQL
echo "📦 Installing PostgreSQL..."
apt install -y postgresql postgresql-contrib
systemctl start postgresql
systemctl enable postgresql

# Install Nginx
echo "📦 Installing Nginx..."
apt install -y nginx
systemctl start nginx
systemctl enable nginx

# Install Certbot for SSL
echo "📦 Installing Certbot..."
apt install -y certbot python3-certbot-nginx

# Install PM2 globally
echo "📦 Installing PM2..."
npm install -g pm2

# Install build tools (if needed)
apt install -y build-essential

# Create logs directory
echo "📁 Creating logs directory..."
mkdir -p /home/ubuntu/ai-therapist/logs
chown -R ubuntu:ubuntu /home/ubuntu/ai-therapist/logs

# Setup firewall
echo "🔥 Configuring firewall..."
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

# Create database and user
echo "🗄️  Setting up database..."
sudo -u postgres psql << EOF
CREATE DATABASE ai_therapist;
CREATE USER therapist_admin WITH PASSWORD 'temp_password_change_this';
GRANT ALL PRIVILEGES ON DATABASE ai_therapist TO therapist_admin;
\c ai_therapist
GRANT ALL ON SCHEMA public TO therapist_admin;
EOF

# Configure PostgreSQL authentication
echo "🔐 Configuring PostgreSQL authentication..."
PG_VERSION=$(ls /etc/postgresql/)
PG_HBA="/etc/postgresql/$PG_VERSION/main/pg_hba.conf"
echo "local   ai_therapist    therapist_admin                  md5" | cat - "$PG_HBA" > temp && mv temp "$PG_HBA"
systemctl restart postgresql

# Setup log rotation
echo "📋 Setting up log rotation..."
cat > /etc/logrotate.d/ai-therapist << 'EOF'
/home/ubuntu/ai-therapist/logs/*.log {
    daily
    rotate 14
    compress
    delaycompress
    notifempty
    missingok
    create 0640 ubuntu ubuntu
    sharedscripts
    postrotate
        pm2 reloadLogs
    endscript
}
EOF

# Create backup directory
echo "💾 Creating backup directory..."
mkdir -p /home/ubuntu/backups
chown ubuntu:ubuntu /home/ubuntu/backups

# Setup automated daily backups
echo "⏰ Setting up automated backups..."
(crontab -u ubuntu -l 2>/dev/null; echo "0 2 * * * pg_dump -U therapist_admin ai_therapist > /home/ubuntu/backups/daily_backup_\$(date +\%Y\%m\%d).sql") | crontab -u ubuntu -

# Cleanup old backups (keep 7 days)
(crontab -u ubuntu -l 2>/dev/null; echo "0 3 * * * find /home/ubuntu/backups -name 'daily_backup_*.sql' -mtime +7 -delete") | crontab -u ubuntu -

echo ""
echo "✅ Server setup completed!"
echo ""
echo "📝 Next steps:"
echo "1. Change the database password:"
echo "   sudo -u postgres psql"
echo "   ALTER USER therapist_admin PASSWORD 'your_secure_password';"
echo ""
echo "2. Upload your application code to /home/ubuntu/ai-therapist"
echo ""
echo "3. Create .env file with your configuration"
echo "   cp .env.example .env"
echo "   nano .env"
echo ""
echo "4. Copy nginx configuration:"
echo "   sudo cp nginx.conf /etc/nginx/sites-available/ai-therapist"
echo "   sudo ln -s /etc/nginx/sites-available/ai-therapist /etc/nginx/sites-enabled/"
echo "   sudo nginx -t"
echo "   sudo systemctl reload nginx"
echo ""
echo "5. Run database migrations:"
echo "   cd /home/ubuntu/ai-therapist"
echo "   for f in src/database/migrations/*.sql; do psql -U therapist_admin -d ai_therapist -f \$f; done"
echo ""
echo "6. Install dependencies and build:"
echo "   npm install"
echo "   npm run build"
echo ""
echo "7. Obtain SSL certificate:"
echo "   sudo certbot --nginx -d ai.byuisresearch.com"
echo ""
echo "8. Start application with PM2:"
echo "   pm2 start ecosystem.config.cjs --env production"
echo "   pm2 save"
echo "   pm2 startup"
echo ""
echo "9. Create initial admin user in the database or use the registration endpoint"
echo ""
echo "🎉 Setup complete! Follow the steps above to deploy your application."
