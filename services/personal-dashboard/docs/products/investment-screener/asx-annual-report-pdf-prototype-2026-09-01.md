# ASX annual-report PDF resolution + extraction prototype

Task: `t_8d5a719d`
Date: 2026-09-01
Status: bounded read-only prototype; no credentials used; no NAS latest artifacts published.

## Headline finding

The ASX PDF URL is still reachable without credentials, but the old direct pattern
`https://www.asx.com.au/asxpdf/{documentKey}.pdf` is stale because the real PDF leaf is
an opaque filename under `https://announcements.asx.com.au/asxpdf/{yyyymmdd}/pdf/*.pdf`.

The current reproducible resolver is:

1. Search official ASX announcements HTML by ASX code and year:

   ```bash
   curl -sS -L --compressed \
     'https://www.asx.com.au/asx/v2/statistics/announcements.do?by=asxCode&asxCode=WOW&timeframe=Y&year=2025'
   ```

2. Pick the annual-report-like row and read its `idsId` from the link:

   ```html
   /asx/v2/statistics/displayAnnouncement.do?display=pdf&idsId=02986107
   ```

3. Fetch the display page. It presents ASX announcement terms and carries the real URL in
   a hidden input named `pdfURL`:

   ```bash
   curl -sS -L --compressed \
     'https://www.asx.com.au/asx/v2/statistics/displayAnnouncement.do?display=pdf&idsId=02986107'
   ```

   Verified hidden value for WOW 2025:

   ```text
   https://announcements.asx.com.au/asxpdf/20250827/pdf/06ndfrjp1s1gn0.pdf
   ```

4. Either GET that hidden PDF URL directly or POST agreement through the terms endpoint:

   ```bash
   curl -sS -L --compressed \
     -H 'User-Agent: Mozilla/5.0 (compatible; Hermes-ASX-PDF-probe/0.1; personal-use research)' \
     -d 'pdfURL=https://announcements.asx.com.au/asxpdf/20250827/pdf/06ndfrjp1s1gn0.pdf' \
     -o /tmp/WOW-2025-annual-report.pdf \
     'https://www.asx.com.au/asx/v2/statistics/announcementTerms.do'
   ```

The MarkitDigital `documentKey` is still useful for recent announcements: the middle
segment is the same `idsId`. Example: `2924-03126055-2A1692062` -> `03126055`, which
resolves through `displayAnnouncement.do?display=pdf&idsId=03126055`. The reason the
prior direct PDF attempts failed is that the middle segment is not the final PDF file
name.

## Prototype script

Added:

```text
services/personal-dashboard/scripts/asx_annual_report_pdf_probe.py
```

Example:

```bash
python3 services/personal-dashboard/scripts/asx_annual_report_pdf_probe.py \
  --code WOW \
  --year 2025 \
  --output-dir /tmp/asx-annual-report-pdf-probe
```

The script:

- searches the official ASX announcements year page;
- selects an `Annual Report` / `Appendix 4E` / full-year announcement row;
- resolves `idsId` -> hidden `pdfURL`;
- posts through `announcementTerms.do` with `pdfURL`;
- downloads the PDF;
- runs local `pdftotext -layout`;
- applies deliberately small line-regex extraction for the screener's blocked fields.

This is a probe, not a production adapter. It is intentionally one issuer/year at a time.

## Validation sample

Small sample only; no bulk backfill attempted.

| Code | Selected ASX announcement | Resolved PDF URL | Extracted fields |
| --- | --- | --- | --- |
| BHP | `02981829` — BHP Appendix 4E and 2025 Annual Report | `https://announcements.asx.com.au/asxpdf/20250819/pdf/06n0rg5dbbgvbl.pdf` | `total_assets=108790`, `total_liabilities=56572`, `current_assets=22830`, `current_liabilities=15639`, `operating_cash_flow=18692`, `capital_expenditures=-9794` (`$M`, USD) |
| WOW | `02986107` — Appendix 4E and Annual Report | `https://announcements.asx.com.au/asxpdf/20250827/pdf/06ndfrjp1s1gn0.pdf` | `total_assets=33829`, `total_liabilities=28867`, `current_assets=6991`, `current_liabilities=12297`, `operating_cash_flow=4550`, `capital_expenditures=-2528` (`$M`, AUD) |
| CBA | `02979638` — 2025 Annual Report | `https://announcements.asx.com.au/asxpdf/20250813/pdf/06mt58385l70tt.pdf` | `total_assets=1353799`, `total_liabilities=1275023`, `operating_cash_flow=-825`, `capital_expenditures=-478`; `current_assets/current_liabilities` not found because banks do not present current/non-current balance sheets in the same way (`$M`, AUD) |

Representative evidence lines returned by the script:

```text
BHP Total assets 108,790 102,362
BHP Total liabilities 56,572 53,242
BHP Net operating cash flows 18,692 20,665
BHP Capital and exploration and evaluation expenditure 9,794 9,273
WOW Total assets 33,829 33,936
WOW Net cash provided by operating activities 4.5 4,550 4,359
CBA Total assets 1,353,799 1,254,076 ↑ 8%
CBA Net cash (used in)/provided by operating activities (825) (25,623) (8,390) 1,719 (27,812)
```

## Terms / robots posture

Verified live:

- `https://www.asx.com.au/robots.txt` returns only `Disallow: /search*`; the tested
  announcements paths are not robots-blocked there.
- `https://announcements.asx.com.au/robots.txt` returns 404; no host-specific robots file
  was available.
- ASX terms page says market announcements are freely available for investors' private
  and personal use only, and not for commercial use without ASX written authority.
- The same terms prohibit use of spiders, screen scrapers, robots, similar software, or
  manual monitoring/copying processes except as otherwise permitted or with ASX consent.

Operational conclusion: resolving and manually validating a few reports for Ben's private
research is a low-volume technical path, but an automated 727-name backfill sits in a ToS
grey/red zone unless ASX grants permission or the implementation is clearly operator-driven
personal use. The legal/permission bit is not something code can charm into compliance.
That would be too convenient, and therefore suspicious.

## Feasibility verdict

PDF resolution is solved. PDF extraction is not production-ready as a lightweight adapter.

Skeleton-based / `pdftotext` line extraction can recover the six blocked screener fields
for standard industrial/retail annual reports, but it is hardening-heavy for the full ASX
backfill because:

- statement labels vary (`Consolidated Balance Sheet`, `Statement of Financial Position`,
  `Net operating cash flows`, `Net cash provided by operating activities`, etc.);
- units and currencies vary (`US$M`, `A$M`, `$000`, occasional per-share tables nearby);
- banks/financials do not expose `current_assets/current_liabilities` in the same shape,
  so the screener must mark those missing or branch by sector;
- multiple statement tables and five-year summaries create false-positive risk;
- CAPEX sign conventions need normalization to the screener's cash-flow convention;
- row regexes need page/table provenance and confidence, not just a number.

Recommended next step if Ben still wants the official-free path: build a separate
`asx-report-extraction` pipeline, not a simple fallback inside `screener.py`. It should
store per-field provenance (`code`, `idsId`, `pdfURL`, report date, page, label, unit,
raw row, parser version, confidence), include sector-aware rules, and run a curated
20-name validation set before any 727-name backfill.

If the objective is coverage quickly rather than source-of-record verification, the prior
recommendation still stands: validate/pay for a licensed fundamentals source first, and
use ASX PDFs as an audit/spot-fill lane.
