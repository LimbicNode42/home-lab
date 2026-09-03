# ASX EODHD Stage 2 fundamentals smoke — t_65e3c02d

Generated: `2026-09-02T15:22:43.673688Z`

## Verdict

**FAIL** — 7 / 10 symbols passed the Stage 2 bar.

Pass bar: at least 8 of 10 with >=2 annual income/balance/cash-flow rows and required fields present.

Baseline before smoke: Yahoo latest pointer reported `usable=1015`, `denominator=1838`, `percent=55.2`; excluded count in manifest was 822.

Because this is below the required 8/10 threshold, do not run the EODHD backfill or publish flow from this sample. The tail is still thin enough to require review / alternate-provider decision before spending writes on the NAS artifact path. Annoying, but cheaper than manufacturing confidence in a spreadsheet costume.

## Sample results

| Symbol | Market cap AUD | Annual depth income / balance / cash | Required fields present | Result |
| --- | ---: | --- | --- | --- |
| `EVN.AU` | 30,770,279,241 | 25 / 25 / 25 | 7/7 | PASS |
| `VMM.AU` | 566,481,786 | 13 / 13 / 12 | 7/7 | PASS |
| `TAM.AU` | 145,712,034 | 37 / 37 / 37 | 7/7 | PASS |
| `CTS.AU` | 53,888,125 | 0 / 0 / 0 | 0/7 | FAIL |
| `KTK.AU` | 30,910,000 | 0 / 0 / 0 | 0/7 | FAIL |
| `SMM.AU` | 19,255,501 | 13 / 13 / 13 | 7/7 | PASS |
| `EGA.AU` | 11,700,000 | 0 / 0 / 0 | 0/7 | FAIL |
| `WC1.AU` | 7,070,688 | 7 / 7 / 7 | 7/7 | PASS |
| `VFX.AU` | 4,332,175 | 6 / 6 / 7 | 7/7 | PASS |
| `LCE.AU` | 0 | 38 / 38 / 38 | 7/7 | PASS |

Failures observed:
- `CTS.AU` (CERETAS LIMITED): HTTP 200, annual depth income/balance/cash = 0/0/0; no required statement fields present.
- `KTK.AU` (KTEK AEROSYSTEMS LTD): HTTP 200, annual depth income/balance/cash = 0/0/0; no required statement fields present.
- `EGA.AU` (EASTERN GAS CORPORATION LIMITED): HTTP 200, annual depth income/balance/cash = 0/0/0; no required statement fields present.

## Secret handling

- API key was read transiently from Vaultwarden runtime session; no raw key is written here.
- JSON evidence source URLs intentionally omit the `api_token` query value.
- Raw provider payloads were not saved; only field-presence/depth evidence was persisted.

Detailed machine-readable evidence: `asx-eodhd-stage2-smoke-2026-09-03.json`.
