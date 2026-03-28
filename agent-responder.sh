#!/bin/bash
# Built by Weblease
# Agent Responder — polls discussions for new user messages, responds as agents via claude CLI

API="http://localhost:3210/api/dashboard"
KEY="ccc8b8f3cf0e7e788c98fab7463fe0ca004d65a39f7ad8509e58a40c90c6f611"
LAST_ID_FILE="/tmp/sales-agent-last-id"
CLAUDE_BIN="/home/christaras9126/.local/bin/claude"

# Initialize last seen ID
if [ ! -f "$LAST_ID_FILE" ]; then
  # Get current max ID so we don't respond to old messages
  CURRENT_MAX=$(curl -s -H "x-admin-key: $KEY" "$API/discussions?limit=1" | node -e "
    let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
      try{const r=JSON.parse(d);console.log(r[0]?r[0].id:0)}catch{console.log(0)}
    })")
  echo "$CURRENT_MAX" > "$LAST_ID_FILE"
fi

echo "[agent-responder] Started. Polling every 5s..."

while true; do
  LAST_ID=$(cat "$LAST_ID_FILE" 2>/dev/null || echo "0")

  # Get recent messages
  MESSAGES=$(curl -s -H "x-admin-key: $KEY" "$API/discussions?limit=10")

  # Find new user (admin) messages after LAST_ID
  NEW_MSG=$(echo "$MESSAGES" | node -e "
    let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
      try{
        const msgs=JSON.parse(d);
        const newOnes=msgs.filter(m=>m.id>$LAST_ID && m.author_role==='admin');
        if(newOnes.length>0) console.log(JSON.stringify(newOnes[newOnes.length-1]));
        else console.log('');
      }catch{console.log('')}
    })")

  if [ -n "$NEW_MSG" ] && [ "$NEW_MSG" != "" ]; then
    MSG_ID=$(echo "$NEW_MSG" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).id)}catch{console.log(0)}})")
    MSG_TEXT=$(echo "$NEW_MSG" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).message)}catch{console.log('')}})")
    MSG_TOPIC=$(echo "$NEW_MSG" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).topic||'general')}catch{console.log('general')}})")

    echo "[agent-responder] New message #$MSG_ID in '$MSG_TOPIC': $MSG_TEXT"

    # Get conversation history for context
    HISTORY=$(curl -s -H "x-admin-key: $KEY" "$API/discussions?topic=$MSG_TOPIC&limit=20")

    # Get agents info
    AGENTS=$(curl -s -H "x-admin-key: $KEY" "$API/agents")

    # Get products info
    PRODUCTS=$(curl -s -H "x-admin-key: $KEY" "$API/products")

    # Get recent leads
    LEADS=$(curl -s -H "x-admin-key: $KEY" "$API/leads?limit=10")

    # Build prompt for Claude
    PROMPT=$(cat <<PROMPT_EOF
Du är ett säljteam med 5 AI-agenter. En admin (Christos) har skrivit ett meddelande i ert mötesrum.

AGENTER:
$(echo "$AGENTS" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{JSON.parse(d).forEach(a=>console.log('- '+a.name+' ('+a.role+'): '+a.description))}catch{}})")

PRODUKTER:
$(echo "$PRODUCTS" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{JSON.parse(d).forEach(p=>console.log('- '+p.display_name+': '+p.description))}catch{}})")

LEADS:
$(echo "$LEADS" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{JSON.parse(d).forEach(l=>console.log('- '+l.email+' ('+l.status+') '+(l.notes||'')))}catch{}})")

KONVERSATION:
$(echo "$HISTORY" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{JSON.parse(d).forEach(m=>console.log(m.author_name+': '+m.message))}catch{}})")

NYTT MEDDELANDE FRÅN ADMIN:
$MSG_TEXT

REGLER:
- Svara som 1-3 relevanta agenter (INTE alla, bara de som berörs)
- Varje agent svarar kort och konkret (max 2-3 meningar)
- Ge specifika förslag, inte fluff
- Svara på SVENSKA
- Format: Varje agent svarar på en egen rad med formatet:
AGENT_ROLE|AGENT_NAME|Meddelande här

Exempel:
scout|Scout|Jag har hittat 5 byråer i Stockholm som matchar. Ska jag lista dem?
outreach|Outreach|Jag kan skicka intro-mail till dem imorgon med wpilot_intro-templaten.
PROMPT_EOF
)

    # Call Claude CLI
    echo "[agent-responder] Calling Claude..."
    RESPONSE=$($CLAUDE_BIN -p "$PROMPT" --max-turns 1 2>/dev/null)

    if [ -n "$RESPONSE" ]; then
      echo "[agent-responder] Got response, posting..."

      # Parse each agent response line and post
      echo "$RESPONSE" | grep '|' | while IFS='|' read -r ROLE NAME MSG; do
        ROLE=$(echo "$ROLE" | xargs)
        NAME=$(echo "$NAME" | xargs)
        MSG=$(echo "$MSG" | xargs)

        if [ -n "$ROLE" ] && [ -n "$NAME" ] && [ -n "$MSG" ]; then
          echo "[agent-responder] Posting as $NAME ($ROLE)"
          curl -s -X POST -H "x-admin-key: $KEY" -H "Content-Type: application/json" \
            "$API/discussions" \
            -d "{\"author_role\":\"$ROLE\",\"author_name\":\"$NAME\",\"message\":\"$MSG\",\"topic\":\"$MSG_TOPIC\"}" > /dev/null
          sleep 1
        fi
      done
    fi

    # Update last seen ID
    echo "$MSG_ID" > "$LAST_ID_FILE"
  fi

  sleep 5
done
