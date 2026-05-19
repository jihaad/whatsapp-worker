#!/bin/bash
set -e

echo "Pulling latest changes..."
git pull

echo "Installing dependencies..."
npm install

echo "Generating Prisma client..."
npx prisma generate

echo "Restarting app..."
sudo -u worker pm2 restart whatsapp-worker

echo "Done! App is running."
sudo -u worker pm2 status