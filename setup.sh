#!/bin/bash
# ─────────────────────────────────────────────────
# AgentNexus API — One-click setup for macOS
# ─────────────────────────────────────────────────
set -e

echo "🚀 AgentNexus API — Setup"
echo "─────────────────────────"

# 1. Check/install Node.js
if command -v node &> /dev/null; then
    echo "✅ Node.js $(node -v) found"
else
    echo "📦 Installing Node.js via Homebrew..."
    if command -v brew &> /dev/null; then
        brew install node
    else
        echo "❌ Homebrew not found. Install it first:"
        echo '   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
        echo "   Then run this script again."
        exit 1
    fi
    echo "✅ Node.js $(node -v) installed"
fi

# 2. Install npm dependencies
echo "📦 Installing dependencies..."
npm install
echo "✅ Dependencies installed"

# 3. Check .env
if grep -q "PASTE_YOUR_KEY_HERE" .env 2>/dev/null; then
    echo ""
    echo "⚠️  Note: Qwen API key not configured in .env"
    echo "   The app will use mock AI responses until you add a real key."
    echo "   To get a key: https://bailian.console.alibabacloud.com → Key Management"
    echo ""
fi

# 4. Start the server
echo "🚀 Starting AgentNexus API..."
echo ""
node server.js
