#!/usr/bin/env python3
"""
Собирает английский словарь документации API: русская строка → английская.

  curl -s localhost:8080/v3/api-docs > ru.json   # документация на русском (исходник — код)
  python3 tools/build_openapi_en.py ru-strings.json backend/src/main/resources/openapi/en.json

Начальный словарь собран этим скриптом; новые строки добавляйте прямо в openapi/en.json.
ru-strings.json — все русские строки документации по порядку. Тест OpenApiI18nTest проверяет,
что в английской версии не осталось ни одной русской буквы: новую строку нужно добавить сюда.
"""
import json
import sys

DESCRIPTION_EN = """Batch-based receiving, expiry dates and FEFO, automatic stop-list, hot offers
and protection against deliberate write-offs.

**How to sign in**
* From a browser — sign in to the app (demo sign-in with any role): this page works on your behalf.
* External system (website, POS, generator) — `X-Api-Key` header with a key from "Admin → API keys".

**Conventions**
* Quantities are integers in grams, millilitres or pieces; money is in kopecks.
* Time is server time, ISO 8601 (UTC).
* `{loc}` in the path is the location: `kush` ("Istokgrad") or `kan` ("Yasnorechye").
* Deliveries and orders are **idempotent**: a repeat with the same ID never doubles the stock.

**Responses**
* `201` — created, `200` — repeat of an already created item or a successful request.
* `409` on an order — refusal: the order is not created; `details` explains what is missing, "maximum N" and similar dishes.
* Errors always look like `{"error": "text", "details": …}`.
"""

EN = [
    "Restaurant Stock — API",                                                   # 0
    DESCRIPTION_EN,                                                             # 1
    "This server",                                                              # 2
    "Sign-in",                                                                  # 3
    "Password, personal PIN on a shared tablet, demo sign-in by role",          # 4
    "Deliveries and receiving",                                                 # 5
    "A delivery arrives as a document; batches appear only after receiving (spec 5.1)",  # 6
    "Orders",                                                                   # 7
    "All-or-nothing order: check, FEFO write-off, refusal with explanation, cancellation (spec 5.5–5.6)",  # 8
    "Stock and batches",                                                        # 9
    "Stock levels, batches, traceability, opening packs, batch recall (spec 5.2–5.3, 5.16)",  # 10
    "Prep (semi-finished)",                                                     # 11
    "Semi-finished items: raw goods by FEFO → a new batch with its own expiry (spec 5.4)",  # 12
    "Menu, stop-list, hot offers",                                              # 13
    "Available portions, stop-list and its forecast, hot offers (spec 5.7, 5.10, 5.12)",  # 14
    "Purchasing",                                                               # 15
    "What to order and what not to order (spec 5.9)",                           # 16
    "Write-offs",                                                               # 17
    "Manual write-off only via a request with a photo; manager signature (spec 6.5)",  # 18
    "Inventory count",                                                          # 19
    "Physical count against the ledger at moment T (spec 6.10)",                # 20
    "Anti-fraud and ledger",                                                    # 21
    "Append-only ledger, hash chain, suspicious operations (spec 6.3–6.11)",    # 22
    "Analytics and dashboard",                                                  # 23
    "Losses, shortages, today's metrics (spec 5.12, 5.15)",                     # 24
    "Alerts and real time",                                                     # 25
    "Alerts on expiry, stop-list, requests, anomalies; SSE event stream (spec 5.8, 5.13)",  # 26
    "Catalog and recipes",                                                      # 27
    "Products, dishes, variants, versioned recipes, catalog import (spec 5.4, 6.9, item 48)",  # 28
    "Administration",                                                           # 29
    "Staff, API keys, settings and thresholds, audit",                          # 30
    "Demo",                                                                     # 31
    "Accelerated clock, event generator, scenarios, reset (demo mode only)",    # 32
    "Website widget",                                                           # 33
    "Read-only by the location's public key — for the restaurant website (item 49)",  # 34
    "Enter counted quantities per product",                                     # 35
    "Expected quantity at moment T is calculated from the ledger.",             # 36
    "Location: kush — \"Istokgrad\", kan — \"Yasnorechye\"",                           # 37
    "Identifier",                                                               # 38
    "New recipe version for a dish",                                            # 39
    "A portion size increase over 20% is flagged as a suspicious operation.",   # 40
    "New recipe version for a prep item",                                       # 41
    "Change a setting",                                                         # 42
    "Setting key",                                                              # 43
    "Write-off requests",                                                       # 44
    "Filter by status",                                                         # 45
    "Manual write-off request with a photo",                                    # 46
    "Reasons: SPOILED — spoiled, DAMAGED — damaged, OTHER — other. \"Expired\" is set by the system only. "
    "A storekeeper below the threshold — executed at once; a cook or anything above the threshold — waits for "
    "a manager's signature; while waiting, the quantity is not sold.",          # 47
    "Batch ID",                                                                 # 48
    "Quantity: grams, millilitres or pieces",                                   # 49
    "Reason: SPOILED — spoiled, DAMAGED — damaged, OTHER — other",              # 50
    "Comment (required for \"other\")",                                         # 51
    "Reject the request",                                                       # 52
    "The held quantity goes back on sale.",                                     # 53
    "Sign the write-off",                                                       # 54
    "You cannot sign your own request.",                                        # 55
    "Prepare a prep item",                                                      # 56
    "Raw goods are written off by FEFO; the new batch expires no later than the earliest raw batch. "
    "On shortage — 409 with an explanation.",                                   # 57
    "Orders list",                                                              # 58
    "How many records to return",                                               # 59
    "Create an all-or-nothing order",                                           # 60
    "201 — created, products written off by FEFO; 200 — repeat with the same externalId; 409 — refusal: "
    "the order is not created, details contains what is missing, \"maximum N\" and similar available dishes.",  # 61
    "Change order status",                                                      # 62
    "Forward only: NEW → ACCEPTED → COOKING → READY → DELIVERING → DONE.",     # 63
    "Cancel an order",                                                          # 64
    "Before \"cooking\" — products return to the same batches. After — products do not return, the loss is "
    "attributed to the employee, a reason is required.",                        # 65
    "Inventory count history",                                                  # 66
    "Start a count",                                                            # 67
    "Moment T is fixed; sales do not stop.",                                    # 68
    "Submit the count",                                                         # 69
    "If the discrepancy exceeds the threshold and the sender is not a manager, it waits for confirmation.",  # 70
    "Confirm the count",                                                        # 71
    "Deliveries list",                                                          # 72
    "Receive a new delivery",                                                   # 73
    "Idempotent by id: 201 — created and waiting for receiving, 200 — repeat of the same, 409 — same id with "
    "different content. A key with the deliveries:auto-accept scope receives the delivery at once.",  # 74
    "Reject a delivery",                                                        # 75
    "Invoice photo before receiving",                                           # 76
    "Receive a delivery: actual vs invoice",                                    # 77
    "Creates batches and fixes expiry dates for good. 428 — the product expires soon, repeat with "
    "confirmShortLife=true; 422 — expired goods cannot be received.",           # 78
    "Unblock a batch",                                                          # 79
    "Open packs",                                                               # 80
    "The opened part is split into a sub-batch with a short expiry (shelf life after opening).",  # 81
    "Write off the remainder of a blocked batch",                               # 82
    "Recall or return to supplier.",                                            # 83
    "Block a batch (recall)",                                                   # 84
    "The batch is removed from sale at once; cascade=true — also the prep items made from it.",  # 85
    "Mark an alert as seen",                                                    # 86
    "Mark all non-critical alerts as seen",                                     # 87
    "Run a scenario",                                                           # 88
    "RUSH — rush hour, SHORT_LIFE — short-life delivery, SHORTAGE — salmon shortage, SUSPICIOUS — suspicious "
    "employee, LATE_CANCELS — late cancellations.",                             # 89
    "Recreate demo data",                                                       # 90
    "Turn the event generator on or off",                                       # 91
    "Clock: speed, pause, fast-forward",                                        # 92
    "Time never goes back.",                                                    # 93
    "Catalog import",                                                           # 94
    "JSON with the client's external IDs. A changed recipe gets a new version; old versions never change.",  # 95
    "Sign in with a personal PIN on a shared tablet",                           # 96
    "After 5 wrong attempts — locked for 5 minutes.",                           # 97
    "Sign out",                                                                 # 98
    "Sign in with login and password",                                          # 99
    "Demo sign-in by role",                                                     # 100
    "Demo mode only. Roles: COOK, CASHIER, STOREKEEPER, MANAGER, ADMIN.",       # 101
    "Staff",                                                                    # 102
    "Create an employee",                                                       # 103
    "Password — for the office, PIN (4–6 digits) — for a shared tablet. Only hashes are stored.",  # 104
    "API keys",                                                                 # 105
    "Issue an API key",                                                         # 106
    "The key is shown once — only its hash is stored.",                         # 107
    "Review an anomaly",                                                        # 108
    "Status: REVIEWED, CONFIRMED or FALSE.",                                    # 109
    "Enable or disable an employee",                                            # 110
    "Stop-list and recommendations for the restaurant website",                 # 111
    "Read-only, by the location's public key, no cookies.",                     # 112
    "Location public key (for the widget)",                                     # 113
    "Health check",                                                             # 114
    "Request photo",                                                            # 115
    "Stop-list forecast",                                                       # 116
    "When a dish runs out of portions and why: a product runs out or a batch expires.",  # 117
    "Forecast horizon, hours",                                                  # 118
    "Stock by product",                                                         # 119
    "Available, expiring soon, awaiting write-off, blocked, days of cover.",    # 120
    "What to order and what not to order",                                      # 121
    "Menu with available portions and stop-list",                               # 122
    "Portions = minimum over recipe products of ⌊available / gross⌋.",          # 123
    "Stock movement ledger",                                                    # 124
    "Append-only; every record holds the hash of the previous one.",            # 125
    "Movement type, e.g. ORDER or WRITEOFF_SPOILED",                            # 126
    "Product ID, e.g. salmon",                                                  # 127
    "Records before this number — for paging",                                  # 128
    "Verify hash chain integrity",                                              # 129
    "Shows the number of the first altered record if the chain is broken.",     # 130
    "Hot offers with explanations",                                             # 131
    "Dishes whose sale will save products that would otherwise go to waste.",   # 132
    "Real-time event stream (SSE)",                                             # 133
    "Events: stock, alert, clock, reset.",                                      # 134
    "Today's metrics and ledger integrity",                                     # 135
    "Batches in FEFO order",                                                    # 136
    "The batch that expires first comes first.",                                # 137
    "Include empty batches",                                                    # 138
    "Batch card: where it came from and where it went",                         # 139
    "All batch movements, orders made from it, sub-batches and prep items.",    # 140
    "Suspicious operations",                                                    # 141
    "Rules A1–A8: writes off more than others, writing off fresh goods, before closing, expensive items, "
    "late cancellations, portion increase, repeated shortages and receiving discrepancies.",  # 142
    "Losses",                                                                   # 143
    "By reason, product, employee and day; share of purchases.",                # 144
    "Period, days",                                                             # 145
    "Most short ingredients",                                                   # 146
    "Refusals, stop-list entries, hours in stop, lost revenue.",                # 147
    "Alerts",                                                                   # 148
    "Unacknowledged only",                                                      # 149
    "Demo state: clock and generator",                                          # 150
    "Catalog: products, dishes, variants, recipes",                             # 151
    "Recipe versions",                                                          # 152
    "Location staff for the PIN screen",                                        # 153
    "Location",                                                                 # 154
    "Who am I",                                                                 # 155
    "App settings: locations, demo mode, server clock",                         # 156
    "Settings and thresholds",                                                  # 157
    "Admin action audit",                                                       # 158
    "Append-only, with its own hash chain.",                                    # 159
    "Revoke an API key",                                                        # 160
    "Order",                                                                    # 161
    "Order number in the external system — a repeat with the same number does not write off twice",  # 162
    "Source: POS — cash register, SITE — website, GENERATOR — generator, API — other",  # 163
    "Order dishes",                                                             # 164
    "Order line",                                                               # 165
    "Dish (variant) ID: e.g. rc9 — \"Philadelphia\", pz1-30 — \"Bolognese 30 cm\"",  # 166
    "Number of portions, 1–100",                                                # 167
    "New order status",                                                         # 168
    "ACCEPTED, COOKING, READY, DELIVERING or DONE",                             # 169
    "Order cancellation",                                                       # 170
    "Reason; required if the order is already being cooked",                   # 171
    "The guest left",                                                           # 172
    "Delivery",                                                                 # 173
    "Unique delivery identifier — a repeat with the same id never doubles the stock",  # 174
    "Human-readable delivery number",                                           # 175
    "D-42",                                                                     # 176
    "Delivery creation date — expiry is counted from it",                      # 177
    "Supplier",                                                                 # 178
    "Fish Yard LLC",                                                            # 179
    "Delivery products",                                                        # 180
    "Delivery line",                                                            # 181
    "Product ID; an unknown one is created automatically and flagged \"needs review\"",  # 182
    "Name on the invoice",                                                      # 183
    "Salmon",                                                                   # 184
    "Unit: G — grams, ML — millilitres, PCS — pieces",                          # 185
    "Invoice quantity in base units",                                           # 186
    "Shelf life, hours (or set expiresAt)",                                     # 187
    "Explicit expiry date (instead of shelfLifeHours)",                         # 188
    "Line total, kopecks",                                                      # 189
    "Delivery receiving",                                                       # 190
    "Actual quantities per line; empty — everything as invoiced",              # 191
    "I confirm receiving a product that expires soon",                          # 192
    "Actual quantity for a line",                                               # 193
    "Delivery line number",                                                     # 194
    "Actual quantity; not set — as invoiced",                                   # 195
    "External system key with narrow scopes (e.g. orders:create)",              # 196
    "Employee session after signing in to the app",                             # 197
]

if __name__ == "__main__":
    ru = json.load(open(sys.argv[1], encoding="utf-8"))
    if len(ru) != len(EN):
        sys.exit(f"строк на русском {len(ru)}, переводов {len(EN)} — списки разошлись")
    with open(sys.argv[2], "w", encoding="utf-8") as f:
        json.dump(dict(zip(ru, EN)), f, ensure_ascii=False, indent=1)
    print(f"en.json: {len(EN)} строк")
