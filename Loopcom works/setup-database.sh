#!/bin/bash
# Database setup script for Trim Pro
# Run this on the server

set -e

DB_NAME="trimpro"
DB_USER="trimpro_user"
# Generate a random password (you should change this!)
DB_PASSWORD=$(openssl rand -base64 32 | tr -d "=+/" | cut -c1-25)

echo "=========================================="
echo "Trim Pro - Database Setup"
echo "=========================================="
echo ""

# Check if database already exists
if sudo -u postgres psql -lqt | cut -d \| -f 1 | grep -qw $DB_NAME; then
    echo "⚠️  Database '$DB_NAME' already exists."
    read -p "Do you want to recreate it? (y/N): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo "Dropping existing database..."
        sudo -u postgres psql -c "DROP DATABASE IF EXISTS $DB_NAME;"
        sudo -u postgres psql -c "DROP USER IF EXISTS $DB_USER;"
    else
        echo "Keeping existing database."
        exit 0
    fi
fi

echo "Creating database: $DB_NAME"
sudo -u postgres psql <<EOF
CREATE DATABASE $DB_NAME;
CREATE USER $DB_USER WITH ENCRYPTED PASSWORD '$DB_PASSWORD';
GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;
ALTER DATABASE $DB_NAME OWNER TO $DB_USER;
\q
EOF

echo ""
echo "✅ Database created successfully!"
echo ""
echo "=========================================="
echo "Database Connection Info:"
echo "=========================================="
echo "Database: $DB_NAME"
echo "User: $DB_USER"
echo "Password: $DB_PASSWORD"
echo ""
echo "DATABASE_URL for .env file:"
echo "postgresql://$DB_USER:$DB_PASSWORD@localhost:5432/$DB_NAME?schema=public"
echo ""
echo "⚠️  IMPORTANT: Save this password! You'll need it for your .env file."
echo ""
