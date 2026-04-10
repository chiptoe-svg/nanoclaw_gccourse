# Agent Playground Setup

## Part 1: Terminal Commands

SSH into your VPS and run these commands:

```bash
# Open firewall ports (web hosting + playground)
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 3002/tcp

# Install Caddy web server
cd /tmp
wget "https://github.com/caddyserver/caddy/releases/download/v2.9.1/caddy_2.9.1_linux_amd64.deb"
sudo dpkg -i caddy_2.9.1_linux_amd64.deb

# Create web hosting directory
sudo mkdir -p /var/www/sites
sudo chown $USER:$USER /var/www/sites

# Configure Caddy
sudo tee /etc/caddy/Caddyfile > /dev/null << 'EOF'
:80 {
    root * /var/www/sites
    file_server browse
}
EOF

# Start Caddy
sudo systemctl enable caddy
sudo systemctl restart caddy

# Upgrade Claude Code
claude update
```

## Part 2: Claude Code

Open Claude Code:

```bash
cd ~/nanoclaw
claude
```

Then give it this prompt:

```
Pull the latest changes from https://github.com/chiptoe-svg/nanoclaw_gccourse.git main, install dependencies, rebuild, enable the Agent Playground, and restart NanoClaw. Here's exactly what to do:

1. git pull https://github.com/chiptoe-svg/nanoclaw_gccourse.git main
2. npm install
3. npm run build
4. Add Environment=PLAYGROUND_ENABLED=1 to ~/.config/systemd/user/nanoclaw.service (under the [Service] section, after the existing Environment lines)
5. systemctl --user daemon-reload
6. systemctl --user restart nanoclaw
7. Verify NanoClaw is running: systemctl --user status nanoclaw
8. Verify the playground is listening: ss -tlnp | grep 3002

Also update groups/global/CLAUDE.md — add this section:

## Web Hosting

You can create and host websites. Find your IP with: curl -4 ifconfig.me

To create a site, write HTML/CSS/JS files to /var/www/sites/<site-name>/.
The site will be immediately available at http://<YOUR_IP>/<site-name>/.

Keep sites self-contained (inline CSS/JS or relative paths). No build tools needed — just static files.
```

## Part 3: Verify

1. Open `http://YOUR_VPS_IP:3002` in your browser
2. Enter password: `godfrey`
3. You should see the Agent Playground with three modes: **Test**, **Agent Persona**, and **Skills**

## What You Can Do

- **Test mode**: Chat with your draft agent and watch the execution trace
- **Agent Persona mode**: Edit your agent's persona, browse a library of persona templates, copy/paste sections into your draft
- **Skills mode**: View your agent's skills, browse available skill libraries, add skills to your agent
- **Apply to Main**: When you're happy with your draft, click Apply to push changes to your live Telegram agent
