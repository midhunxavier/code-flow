# Phone count audit follow-through

The frozen `a4509f1` browser suite recorded six passing phone-pairing scenarios followed by an audit failure for a 401 from `GET /api/projects/counts` on the TLS listener. The original log does not record the page, response body or timing, so its exact cause remains unknown. Its single unchanged whole-file replay passed 6/6 (`phone-revocation-replay/unchanged.log`); that pass does not replace the original failed result.

The phone app refreshes project counts in the background. A controlled separate replay held a phone count request, confirmed that the owner removed that device, and released the request. It returned the exact sign-in-required 401. The six original behavioral scenarios passed, but the original broad console audit failed on that intentional response (`phone-auth-audit/controlled.log`; timing and body in `phone-auth-audit/evidence/controlled-revocation.json`). This demonstrates a possible legitimate lifecycle; it does not prove the historical response had that cause.

The fixture audit now records page identity, response URL, method, status, body and receipt time, together with the owner-confirmed device removal and rotation. It can consume only a one-to-one console/response match for the specific invalidated page, the exact TLS count route and the exact sign-in-required 401 at or after confirmed removal or rotation. Unmatched, duplicate, premature, unconfirmed and unrelated responses still fail. Body reads are drained before and after browser close; every observed count 401 is checked even if Chrome emits no console error, and an unreadable body fails; future diagnostic evidence is saved in the test scratch directory when no evidence directory is configured. The original assertions remain intact; the test additionally confirms that the removed device ID disappeared and that rotation changed the phone link. No production code changed.

Validation used separate scratch homes, servers, repositories and Chrome:

- Controlled held request with corrected audit: 6/6 original behavioral scenarios and strict audit pass; its captured exact 401 and transition receipt are in `phone-auth-audit/reviewed-control/`.
- Original six behavioral scenarios with only the instrumented audit: 6/6 pass (`phone-auth-audit/reviewed-original.log`). No count 401 occurred in that run.
- Classifier unit checks reject other pages, paths, origins, methods, bodies, statuses, missing confirmation, early responses and duplicate console errors (`phone-auth-audit/reviewed-classifier.log`).
- TypeScript passes (`phone-auth-audit/reviewed-tsc.log`).

All paths are under `/private/tmp/codeflow-qa-continue/`. The original frozen full-suite failure remains visible and unclassified.

Independent review found two audit boundaries in the initial correction. The final version checks response receipt against confirmation, not merely initiation, and drains reads again after browser close. Responses in the interval before confirmation remain failures; a negative unit case covers each transition.
