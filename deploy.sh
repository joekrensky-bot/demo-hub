#!/bin/bash
echo ""
echo "Jasper Hub — Netlify Deploy"
echo "==========================="
echo ""

# Install Netlify CLI if not present
if ! command -v netlify &> /dev/null; then
  echo "Installing Netlify CLI..."
  npm install -g netlify-cli
fi

echo "Deploying to Netlify..."
echo ""
echo "When prompted, choose:"
echo "  - Create & configure a new site"
echo "  - Select your Netlify team"
echo "  - Hit Enter for default site name (or type one)"
echo ""

netlify deploy --prod --dir .

echo ""
echo "==========================================="
echo "NEXT STEP: Add your Anthropic API key"
echo "==========================================="
echo ""
echo "1. Go to your Netlify site dashboard"
echo "2. Site configuration → Environment variables"
echo "3. Add variable:"
echo "   Key:   OPENAI_API_KEY"
echo "   Value: (your key from platform.openai.com/api-keys)"
echo "4. Deploys → Trigger deploy → Deploy site"
echo ""
