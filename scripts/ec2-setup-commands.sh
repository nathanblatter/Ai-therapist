#!/bin/bash

# EC2 Setup Commands for ai.byuisresearch.com
# Run these commands on your EC2 instance

# If you already have files there, remove the directory first:
echo "Removing existing directory if present..."
rm -rf /home/ubuntu/ai-therapist

# Clone fresh from GitHub
echo "Cloning repository..."
cd /home/ubuntu
git clone https://github.com/nathanzbl/Ai-therapist.git ai-therapist
cd ai-therapist

# OR if you prefer to keep existing files and just update git:
# cd /home/ubuntu/ai-therapist
# git init
# git remote add origin https://github.com/nathanzbl/Ai-therapist.git
# git fetch
# git reset --hard origin/main

echo "Repository cloned successfully!"
