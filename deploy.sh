#!/bin/bash
set -e

echo "Pulling latest changes..."
git pull

echo "Installing dependencies..."
npm install

echo "Generating Prisma client..."
npx prisma generate

echo "Restarting app..."
pm2 restart whatsapp-worker

echo "Done! App is running."
pm2 status