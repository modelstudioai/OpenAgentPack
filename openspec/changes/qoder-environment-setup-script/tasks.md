## 1. Configuration contract

- [x] 1.1 Add `setup_script` to the environment type and parser with a UTF-8 64 KB limit
- [x] 1.2 Add provider-aware validation for setup-script support and Qoder writable package managers

## 2. Qoder reconciliation

- [x] 2.1 Map and reverse-map setup scripts and canonicalize Qoder package responses
- [x] 2.2 Include setup scripts in Qoder desired/remote comparable state and drift detection
- [x] 2.3 Correct Qoder Environment updates to POST and converge removed metadata keys

## 3. Verification coverage

- [x] 3.1 Add parser and provider validation boundary tests
- [x] 3.2 Add Qoder Environment create/update, sync, normalization, and drift regression tests
- [x] 3.3 Update the live drift fixture to cover setup scripts and response-only package fields

## 4. Documentation

- [x] 4.1 Update English and Chinese configuration/environment documentation with setup-script semantics and safety guidance
- [x] 4.2 Add a Qoder example using an idempotent multiline setup script

## 5. Delivery verification

- [x] 5.1 Run focused tests, SDK typecheck, scoped verification, and the full SDK suite
- [x] 5.2 Review the complete diff and fix all actionable findings
- [x] 5.3 Load `.env` and verify disposable Qoder Environment create, update, readback/drift, and cleanup against the live API
