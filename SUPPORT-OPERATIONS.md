# PuckVolt support and moderation

Assign the support queue to an operator with access to the PuckVolt Cloudflare D1 database. Do not share access with players. Review the queue daily once the public launch begins.

- Review new player-name reports in the `name_reports` table. Verify the name and record a decision in `name_reviews`. The key is the reported name in lowercase with spaces, dashes, and underscores removed. Use `block` when the name violates the Terms of Play or `dismiss` when the report does not warrant action. Record the review time as epoch milliseconds. A blocked name is rejected on registration and prevents its current holder from entering another online match until renamed in Account. Allow roughly a minute for the live game to refresh the decision.
- Review player requests in the `support_requests` table and respond using the operator’s public support inbox. The ticket reference is its ID. Never ask players for passwords or full card details. Remove support contact details when no longer needed to resolve the request or meet a documented retention obligation.
- Keep the privacy notice and store disclosures aligned with player profiles, game data, reports, and support tickets. Check the public support and account deletion URLs when preparing each store listing.

## Retention

The Cloudflare Worker removes support requests, name reports and old dismiss decisions after 90 days during its daily run. Active name blocks remain available to enforce the Terms of Play. The daily Gmail monitor should send ticket references only. Read the actual message and reply address from the private queue. Review any historic Gmail alerts that contain player details and remove copies once their purpose is fulfilled.
