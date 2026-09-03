#!/usr/bin/env python3
"""Resolve ASX annual-report PDF URLs and prototype statement extraction.

Read-only, bounded probe for Kanban task t_8d5a719d. It intentionally fetches one
issuer/year at a time and relies on ASX's public announcements pages plus local
pdftotext. This is not a bulk backfill worker.
"""
from __future__ import annotations

import argparse
import html
import json
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Iterable

USER_AGENT = "Mozilla/5.0 (compatible; Hermes-ASX-PDF-probe/0.1; personal-use research)"
ASX_ANNOUNCEMENTS_URL = "https://www.asx.com.au/asx/v2/statistics/announcements.do"
ASX_DISPLAY_URL = "https://www.asx.com.au/asx/v2/statistics/displayAnnouncement.do"
ASX_TERMS_URL = "https://www.asx.com.au/asx/v2/statistics/announcementTerms.do"


@dataclass
class Announcement:
    code: str
    date: str
    headline: str
    ids_id: str
    pages: str | None
    file_size: str | None
    display_url: str


@dataclass
class ExtractedField:
    value: float | None
    unit: str | None
    label: str | None
    evidence: str | None
    confidence: str


def fetch_text(url: str, data: dict[str, str] | None = None) -> str:
    body = None
    headers = {"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml"}
    if data is not None:
        body = urllib.parse.urlencode(data).encode("utf-8")
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    req = urllib.request.Request(url, data=body, headers=headers)
    with urllib.request.urlopen(req, timeout=45) as resp:
        return resp.read().decode("utf-8", "replace")


def fetch_bytes(url: str, data: dict[str, str] | None = None) -> tuple[bytes, str]:
    body = None
    headers = {"User-Agent": USER_AGENT, "Accept": "application/pdf,text/html;q=0.8,*/*;q=0.5"}
    if data is not None:
        body = urllib.parse.urlencode(data).encode("utf-8")
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    req = urllib.request.Request(url, data=body, headers=headers)
    with urllib.request.urlopen(req, timeout=90) as resp:
        return resp.read(), resp.headers.get("Content-Type", "")


def strip_tags(fragment: str) -> str:
    fragment = re.sub(r"<script[\s\S]*?</script>|<style[\s\S]*?</style>", " ", fragment, flags=re.I)
    fragment = re.sub(r"<br\s*/?>", "\n", fragment, flags=re.I)
    fragment = re.sub(r"<[^>]+>", " ", fragment)
    return re.sub(r"[ \t]+", " ", html.unescape(fragment)).strip()


def list_announcements(code: str, year: int) -> list[Announcement]:
    query = urllib.parse.urlencode({"by": "asxCode", "asxCode": code.upper(), "timeframe": "Y", "year": str(year)})
    search_url = f"{ASX_ANNOUNCEMENTS_URL}?{query}"
    page = fetch_text(search_url)
    announcements: list[Announcement] = []
    for row_match in re.finditer(r"<tr[\s\S]*?</tr>", page, flags=re.I):
        row = row_match.group(0)
        link = re.search(r'href="([^"]*displayAnnouncement\.do\?display=pdf&amp;idsId=(\d+)[^"]*)"', row, flags=re.I)
        if not link:
            continue
        ids_id = link.group(2)
        plain = strip_tags(row)
        # The first non-empty line is the date. Headline is the text before the PDF icon metadata.
        lines = [ln.strip() for ln in plain.splitlines() if ln.strip()]
        date = lines[0] if lines else ""
        content_lines = lines[1:]
        if content_lines and re.match(r"^\d{1,2}:\d{2}\s*(am|pm)$", content_lines[0], flags=re.I):
            content_lines = content_lines[1:]
        headline_blob = " ".join(content_lines)
        headline_blob = re.sub(r"\b\d+\s+pages?\b.*$", "", headline_blob, flags=re.I).strip()
        pages_match = re.search(r'<span class="page">\s*([^<]+?)\s*</span>', row, flags=re.I)
        size_match = re.search(r'<span class="filesize">\s*([^<]+?)\s*</span>', row, flags=re.I)
        pages = re.sub(r"\s+", " ", pages_match.group(1)).strip() if pages_match else None
        file_size = re.sub(r"\s+", " ", size_match.group(1)).strip() if size_match else None
        display_url = urllib.parse.urljoin("https://www.asx.com.au", html.unescape(link.group(1)))
        announcements.append(Announcement(code.upper(), date, headline_blob, ids_id, pages, file_size, display_url))
    return announcements


def pick_annual_report(items: Iterable[Announcement], headline_re: str | None = None) -> Announcement:
    patterns = [headline_re] if headline_re else [
        r"appendix\s+4e.*annual\s+report|annual\s+report.*appendix\s+4e",
        r"\bannual\s+report\b",
        r"full\s+year\s+results\s+announcement",
    ]
    scored: list[tuple[int, Announcement]] = []
    for item in items:
        h = item.headline.lower()
        for rank, pat in enumerate(patterns):
            if pat and re.search(pat, h, flags=re.I):
                scored.append((rank, item))
                break
    if not scored:
        raise SystemExit("No annual-report-like announcement matched the requested year/headline")
    return sorted(scored, key=lambda pair: pair[0])[0][1]


def resolve_pdf_url(ids_id: str) -> str:
    query = urllib.parse.urlencode({"display": "pdf", "idsId": ids_id})
    page = fetch_text(f"{ASX_DISPLAY_URL}?{query}")
    match = re.search(r'name="pdfURL"\s+value="([^"]+)"', page)
    if not match:
        raise SystemExit(f"Could not find hidden pdfURL in displayAnnouncement response for idsId={ids_id}")
    return html.unescape(match.group(1))


def download_pdf(pdf_url: str, output_pdf: Path, agree_terms: bool = True) -> dict[str, object]:
    output_pdf.parent.mkdir(parents=True, exist_ok=True)
    if agree_terms:
        content, content_type = fetch_bytes(ASX_TERMS_URL, data={"pdfURL": pdf_url})
    else:
        content, content_type = fetch_bytes(pdf_url)
    if content[:4] != b"%PDF":
        raise SystemExit(f"Resolved URL did not return a PDF: content_type={content_type!r}, first_bytes={content[:32]!r}")
    output_pdf.write_bytes(content)
    return {"path": str(output_pdf), "bytes": len(content), "content_type": content_type}


def pdftotext(pdf_path: Path, txt_path: Path) -> None:
    txt_path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["pdftotext", "-layout", str(pdf_path), str(txt_path)], check=True)


def parse_number(raw: str) -> float:
    raw = raw.strip().replace(",", "")
    if raw in {"–", "-"}:
        return 0.0
    neg = raw[:1] == "(" and raw[-1:] == ")"
    raw = raw.strip("()")
    val = float(raw)
    return -val if neg else val


def likely_financial_numbers(line: str) -> list[str]:
    """Return candidate money amounts from a statement line, left-to-right.

    pdftotext preserves table rows but not table structure. This deliberately favours
    the first substantial amount on the row, which is normally the current-period group
    figure after any note reference. It skips note numbers and percentages such as
    ``4.5`` or ``8%`` without pretending this is a real parser. Because it isn't.
    """
    candidates: list[str] = []
    for match in re.finditer(r"(?<![\d.])\(?-?\d[\d,]*(?:\.\d+)?\)?(?![\d.])|–", line):
        raw = match.group(0)
        tail = line[match.end(): match.end() + 3].lstrip()
        if tail[:1] == "%":
            continue
        if raw == "–":
            candidates.append(raw)
            continue
        value = abs(parse_number(raw))
        # Small unparenthesized/no-comma numbers are usually note references, page
        # numbers, or percentage remnants. Parentheses often indicate real cash outflows.
        if "," not in raw and raw[:1] != "(" and value < 1000:
            continue
        candidates.append(raw)
    return candidates


def line_field(text: str, patterns: list[str], unit: str) -> ExtractedField:
    lines = text.splitlines()
    for line in lines:
        collapsed = re.sub(r"\s+", " ", line).strip()
        for pat in patterns:
            if re.search(pat, collapsed, flags=re.I):
                nums = likely_financial_numbers(collapsed)
                if nums:
                    return ExtractedField(parse_number(nums[0]), unit, collapsed[:120], collapsed, "prototype_line_regex")
    return ExtractedField(None, unit, None, None, "not_found")


def extract_statement_fields(text_path: Path, code: str) -> dict[str, ExtractedField]:
    text = text_path.read_text(errors="ignore")
    # Scope to the financial statements half of the report when possible. This reduces
    # false positives from operating reviews, but remains intentionally simple.
    lower = text.lower()
    anchors = [lower.find("statement of financial position"), lower.find("consolidated balance sheet"), lower.find("total assets")]
    scope_offsets = [a for a in anchors if a >= 0]
    scoped = text[min(scope_offsets):] if scope_offsets else text
    fields = {
        "total_assets": line_field(scoped, [r"^total assets\b"], "$M"),
        "total_liabilities": line_field(scoped, [r"^total liabilities\b"], "$M"),
        "current_assets": line_field(scoped, [r"^total current assets\b", r"^current assets\b.*\btotal\b"], "$M"),
        "current_liabilities": line_field(scoped, [r"^total current liabilities\b", r"^current liabilities\b.*\btotal\b"], "$M"),
        "operating_cash_flow": line_field(scoped, [r"net (operating cash flows|cash provided by operating activities|cash \(used in\)/provided by operating)"], "$M"),
        "capital_expenditures": line_field(scoped, [r"(payments for|purchases of) property, plant and equipment", r"capital and exploration.*expenditure"], "$M"),
    }
    # Capex should be represented as the screener's Yahoo-style capital expenditures:
    # usually a negative cash-flow line. BHP's management table presents positive spend.
    capex = fields["capital_expenditures"]
    if capex.value is not None and capex.value > 0 and capex.evidence and re.search(r"capital.*expenditure|purchases", capex.evidence, re.I):
        capex.value = -capex.value
        capex.confidence += ";sign_normalized_to_cash_outflow"
    return fields


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--code", required=True, help="ASX code, e.g. BHP")
    ap.add_argument("--year", type=int, required=True, help="announcement search year")
    ap.add_argument("--headline-regex", help="override annual-report headline selector")
    ap.add_argument("--output-dir", type=Path, default=Path("/tmp/asx-annual-report-pdf-probe"))
    ap.add_argument("--sleep-seconds", type=float, default=1.0)
    args = ap.parse_args()

    code = args.code.upper()
    announcements = list_announcements(code, args.year)
    selected = pick_annual_report(announcements, args.headline_regex)
    time.sleep(args.sleep_seconds)
    pdf_url = resolve_pdf_url(selected.ids_id)
    time.sleep(args.sleep_seconds)

    stem = f"{code}-{args.year}-{selected.ids_id}"
    pdf_path = args.output_dir / f"{stem}.pdf"
    txt_path = args.output_dir / f"{stem}.txt"
    pdf_meta = download_pdf(pdf_url, pdf_path, agree_terms=True)
    pdftotext(pdf_path, txt_path)
    extracted = extract_statement_fields(txt_path, code)

    result = {
        "schema_version": "asx-annual-report-pdf-probe/v1",
        "code": code,
        "year": args.year,
        "selected_announcement": asdict(selected),
        "resolution": {
            "step_1_announcements_url": f"{ASX_ANNOUNCEMENTS_URL}?" + urllib.parse.urlencode({"by": "asxCode", "asxCode": code, "timeframe": "Y", "year": str(args.year)}),
            "step_2_display_url": selected.display_url,
            "step_3_hidden_pdf_url": pdf_url,
            "step_4_terms_post": ASX_TERMS_URL,
            "headers": {"User-Agent": USER_AGENT},
        },
        "download": pdf_meta,
        "text_path": str(txt_path),
        "fields": {key: asdict(value) for key, value in extracted.items()},
    }
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
