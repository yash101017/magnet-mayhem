# Magnet Mayhem

On first launch, choose Play as Guest or Create Account and pick a unique username. Guest profiles reopen automatically in the same browser on the same device. Registered accounts can sign in on another device connected to the same server. Private windows and cleared browser settings use separate guest storage. Pick a course, then select **Online** to open the lobby.

- **Create Room:** Share the room code with a friend and play the course you picked.
- **Ranked Game:** Start matchmaking. Matches between people count toward your rating. The game also keeps a separate skill estimate to scale fallback difficulty. Both sides of every match show a display name.
- **Join Friend:** Enter the six-character room code your friend sends you.

The first to three goals wins. After 90 seconds of play the leader wins, or the next goal decides a tie.

Drag inside the arena to steer. The dashed ring shows magnet range. Pull attracts the puck and Push fires it away. Both buttons use the same cooldown. Keyboard controls are WASD or arrows, Q to pull, and E to push.

## Run it

With Node.js 22 or later, double-click Play.cmd on Windows or run `node server.cjs` in this folder. Go to http://localhost:8792. To test a friend duel in one browser, use a private window for the second player. Two devices on the same Wi-Fi can use the host computer's LAN address and port 8792 if their network allows it.

Run the included server to use the lobby. Friend and ranked games on different devices require a shared running server. For internet play, host the Node server behind HTTPS. Keep one process running and put the profile file on persistent storage. Set MAGNET_DATA_FILE to an absolute writable path when deploying. Rooms and queues reset when the process stops.

## Arena Coins

Competitive matches stake 30 coins. Winners gain 30 and losers lose 30. A server-clock refill adds 100 coins each hour. New profiles start with 100. Free Practice changes neither coins nor skill. The Shop offers an Ice ship for 90 coins and a Comet celebration for 150. Coins and unlocks are saved to the player account.

## Optional cosmetics

Players can preview the $2.99 Neon Founders Pack through Cosmetics or from a results screen. The pack contains Prism and Gold ship styles, rainbow and gold goal celebrations, and a results badge. Use the Shop on the home screen to preview everything. Match opponents can see the selected ship style and celebration. Gameplay, courses, and retries are free.

For web checkout, set MAGNET_PUBLIC_URL to the deployed HTTPS origin and configure STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET in the server environment. Set the Stripe webhook URL to /stripe/webhook on that origin and select checkout.session.completed and checkout.session.async_payment_succeeded. Start with Stripe test credentials. The server grants ownership after verifying the signed payment event. Guest purchases are tied to that browser profile. Registered players can recover purchases by signing in to the same account.

Native Android and iOS packaging, store billing, and public hosting are pending.

## Source

engine.cjs contains shared match physics, client.js contains the interface, and server.cjs runs live matches. After editing the HTML template or either browser module, run `node build.cjs` to regenerate index.html.


