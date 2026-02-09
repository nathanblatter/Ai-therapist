#!/bin/bash

# AI Therapist Deployment Script
# Usage: ./deploy.sh [environment]
# Example: ./deploy.sh production

set -e  # Exit on error

ENVIRONMENT=${1:-production}
APP_DIR="/home/ubuntu/ai-therapist"
BACKUP_DIR="/home/ubuntu/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

echo "🚀 Starting deployment for environment: $ENVIRONMENT"
echo "================================================"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to print colored output
print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠ $1${NC}"
}

print_info() {
    echo -e "ℹ $1"
}

# Check if running as correct user
if [ "$USER" != "ubuntu" ]; then
    print_warning "This script should be run as the ubuntu user"
fi

# Change to app directory
cd "$APP_DIR" || {
    print_error "Failed to change to app directory: $APP_DIR"
    exit 1
}

# Step 1: Backup database
print_info "Step 1: Backing up database..."
mkdir -p "$BACKUP_DIR"
if sudo -u postgres pg_dump ai_therapist > "$BACKUP_DIR/db_backup_$TIMESTAMP.sql"; then
    print_success "Database backup created: $BACKUP_DIR/db_backup_$TIMESTAMP.sql"
else
    print_error "Database backup failed"
    exit 1
fi

# Step 2: Pull latest code
print_info "Step 2: Pulling latest code from repository..."
if git pull origin main; then
    print_success "Code updated successfully"
else
    print_error "Git pull failed"
    exit 1
fi

# Step 3: Install dependencies
print_info "Step 3: Installing dependencies..."
if npm install --production; then
    print_success "Dependencies installed"
else
    print_error "npm install failed"
    exit 1
fi

# Step 4: Run database migrations (if any new ones)
print_info "Step 4: Running database migrations..."
for migration in src/database/migrations/*.sql; do
    if [ -f "$migration" ]; then
        print_info "Applying migration: $(basename $migration)"
        if psql -U therapist_admin -d ai_therapist -f "$migration" 2>&1 | grep -q "ERROR"; then
            print_warning "Migration may have already been applied: $(basename $migration)"
        else
            print_success "Migration applied: $(basename $migration)"
        fi
    fi
done

# Step 5: Build production bundles
print_info "Step 5: Building production bundles..."
if npm run build; then
    print_success "Build completed successfully"
else
    print_error "Build failed"
    exit 1
fi

# Step 6: Restart application with PM2
print_info "Step 6: Restarting application..."
if pm2 restart ai-therapist; then
    print_success "Application restarted"
else
    print_warning "PM2 restart failed, trying to start..."
    if pm2 start ecosystem.config.cjs --env production; then
        print_success "Application started"
    else
        print_error "Failed to start application"
        exit 1
    fi
fi

# Step 7: Save PM2 process list
pm2 save

# Step 8: Reload Nginx
print_info "Step 7: Reloading Nginx..."
if sudo nginx -t && sudo systemctl reload nginx; then
    print_success "Nginx reloaded"
else
    print_error "Nginx configuration test failed"
    exit 1
fi

# Step 9: Health check
print_info "Step 8: Running health check..."
sleep 5  # Wait for app to start

if curl -f -s http://localhost:3000/health > /dev/null; then
    print_success "Health check passed"
else
    print_warning "Health check failed - application may still be starting"
fi

# Step 10: Clean up old backups (keep last 7 days)
print_info "Step 9: Cleaning up old backups..."
find "$BACKUP_DIR" -name "db_backup_*.sql" -mtime +7 -delete
print_success "Old backups cleaned up"

# Display status
echo ""
echo "================================================"
print_success "Deployment completed successfully!"
echo "================================================"
echo ""
print_info "Application status:"
pm2 status ai-therapist
echo ""
print_info "Recent logs:"
pm2 logs ai-therapist --lines 20 --nostream
echo ""
print_info "To view live logs, run: pm2 logs ai-therapist"
print_info "To check status, run: pm2 status"
print_info "Visit: https://ai.byuisresearch.com"
