// ==UserScript==
// @name         BGP.HE.NET — Prefix & ASN Scraper
// @namespace    http://tampermonkey.net/
// @version      1.4
// @description  Scrapes 100% visible IPv4/IPv6 prefixes from AS pages, AND extracts ASN numbers + links from search result pages
// @author       You
// @match        https://bgp.he.net/AS*
// @match        https://bgp.he.net/search*
// @grant        GM_setClipboard
// @grant        GM_notification
// ==/UserScript==

(function () {
  'use strict';

  const BASE_URL = 'https://bgp.he.net';

  // ─── Parse a row and return prefix data if visibility is exactly 100% ─────
  function parseRow(row) {
    // Get prefix text (e.g. "103.50.92.0/23")
    const prefixLink = row.querySelector('td:first-child a');
    if (!prefixLink) return null;
    const prefix = prefixLink.textContent.trim();

    // Get visibility percentage from the bold span
    const boldSpan = row.querySelector('td:last-child span[style*="font-weight:bold"]');
    if (!boldSpan) return null;

    const percentText = boldSpan.textContent.trim(); // e.g. "100% " or "0% "
    const percent = parseFloat(percentText);

    // Only include rows where visibility is exactly 100%
    if (percent !== 100) return null;

    // Get the count (e.g. "843/843")
    const countSpan = boldSpan.nextElementSibling;
    const count = countSpan ? countSpan.textContent.trim() : '';

    // Get description (organisation name), may be empty
    const descCell = row.querySelector('td:nth-child(2)');
    // Clone and remove flag image so we only get text
    const descClone = descCell ? descCell.cloneNode(true) : null;
    if (descClone) {
      descClone.querySelectorAll('img, div.flag').forEach(el => el.remove());
    }
    const description = descClone ? descClone.textContent.trim() : '';

    // IRR status from title attribute on irr image
    const irrImg = row.querySelector('.irrimg img');
    const irrStatus = irrImg ? irrImg.getAttribute('title') : '';

    // ROA / RPKI status
    const roaImg = row.querySelector('.roakey img');
    const roaStatus = roaImg ? roaImg.getAttribute('title') : '';

    return { prefix, percent, count, description, irrStatus, roaStatus };
  }

  // ─── Parse a search-result row, return ASN data only if Type === "ASN" ────
  function parseASNRow(row) {
    const cells = row.querySelectorAll('td');
    if (cells.length < 2) return null;

    // Type is in the 2nd column; we only want ASN rows (skip Domain/TLD/Route)
    const type = cells[1].textContent.trim();
    if (type !== 'ASN') return null;

    // Result link is in the 1st column (e.g. <a href="/AS7280">AS7280</a>)
    const link = cells[0].querySelector('a');
    if (!link) return null;

    const asn = link.textContent.trim();                 // "AS7280"
    const href = link.getAttribute('href') || '';         // "/AS7280"
    const url = href.startsWith('http') ? href : BASE_URL + href;

    // Description (3rd column), strip the flag image/div for clean text
    const descCell = cells[2] ? cells[2].cloneNode(true) : null;
    if (descCell) {
      descCell.querySelectorAll('img, div.flag').forEach(el => el.remove());
    }
    const description = descCell ? descCell.textContent.trim() : '';

    return { asn, url, description };
  }

  // ─── Build the prefix UI panel ─────────────────────────────────────────────
  function createPanel(results, asNumber, ipVersion) {
    const panelId = `bgp-scraper-panel-${ipVersion}`;
    // Remove any existing panel of same type
    const existing = document.getElementById(panelId);
    if (existing) existing.remove();

    const isV6 = ipVersion === 6;
    const accentColor = isV6 ? '#a78bfa' : '#38bdf8'; // purple for v6, blue for v4
    const bottomOffset = '20px';
    const rightOffset  = '20px';

    const panel = document.createElement('div');
    panel.id = panelId;
    // Stack v4 and v6 panels side by side if both open
    panel.style.cssText = `
      position: fixed;
      bottom: ${bottomOffset};
      right: ${isV6 ? '560px' : rightOffset};
      z-index: 999999;
      background: #0f172a;
      color: #e2e8f0;
      font-family: 'Courier New', monospace;
      font-size: 13px;
      border: 1px solid #334155;
      border-radius: 8px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
      max-width: 520px;
      max-height: 70vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    `;

    // Header
    const header = document.createElement('div');
    header.style.cssText = `
      padding: 10px 14px;
      background: #1e293b;
      border-bottom: 1px solid #334155;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
    `;
    header.innerHTML = `
      <span style="font-weight:bold; color:${accentColor};">
        ${isV6 ? '🌐' : '📡'} AS${asNumber} — IPv${ipVersion} 100% Prefixes
        <span style="color:#94a3b8; font-weight:normal;"> (${results.length} found)</span>
      </span>
      <button id="bgp-close-btn-${ipVersion}" style="
        background:none; border:none; color:#94a3b8;
        font-size:16px; cursor:pointer; padding:0 4px; line-height:1;
      ">✕</button>
    `;

    // Scrollable list
    const list = document.createElement('div');
    list.style.cssText = `
      overflow-y: auto;
      padding: 10px 14px;
      flex: 1;
    `;

    if (results.length === 0) {
      list.innerHTML = `<div style="color:#f87171;">No 100% visible prefixes found.</div>`;
    } else {
      results.forEach(r => {
        const item = document.createElement('div');
        item.style.cssText = `
          padding: 5px 0;
          border-bottom: 1px solid #1e293b;
          display: flex;
          gap: 10px;
          align-items: baseline;
        `;
        item.innerHTML = `
          <span style="color:${accentColor}; min-width:${isV6 ? '220px' : '160px'};">${r.prefix}</span>
          <span style="color:#94a3b8; font-size:11px;">${r.count}</span>
          ${r.description ? `<span style="color:#cbd5e1; font-size:11px;">${r.description}</span>` : ''}
        `;
        list.appendChild(item);
      });
    }

    // Footer with action buttons
    const footer = document.createElement('div');
    footer.style.cssText = `
      padding: 10px 14px;
      background: #1e293b;
      border-top: 1px solid #334155;
      display: flex;
      gap: 8px;
      flex-shrink: 0;
    `;

    const btnStyle = `
      padding: 6px 12px;
      border-radius: 5px;
      border: none;
      cursor: pointer;
      font-size: 12px;
      font-family: 'Courier New', monospace;
      font-weight: bold;
    `;

    const copyBtn = document.createElement('button');
    copyBtn.textContent = '📋 Copy Prefixes';
    copyBtn.style.cssText = btnStyle + 'background:#0ea5e9; color:#fff;';
    copyBtn.onclick = () => {
      const text = results.map(r => r.prefix).join('\n');
      GM_setClipboard(text);
      copyBtn.textContent = '✅ Copied!';
      setTimeout(() => { copyBtn.textContent = '📋 Copy Prefixes'; }, 2000);
    };

    const csvBtn = document.createElement('button');
    csvBtn.textContent = '⬇ Export CSV';
    csvBtn.style.cssText = btnStyle + 'background:#10b981; color:#fff;';
    csvBtn.onclick = () => exportCSV(results, asNumber, ipVersion);

    const txtBtn = document.createElement('button');
    txtBtn.textContent = '⬇ Export TXT';
    txtBtn.style.cssText = btnStyle + 'background:#6366f1; color:#fff;';
    txtBtn.onclick = () => exportTXT(results, asNumber, ipVersion);

    footer.appendChild(copyBtn);
    footer.appendChild(csvBtn);
    footer.appendChild(txtBtn);

    panel.appendChild(header);
    panel.appendChild(list);
    panel.appendChild(footer);
    document.body.appendChild(panel);

    document.getElementById(`bgp-close-btn-${ipVersion}`).onclick = () => panel.remove();
  }

  // ─── Build the ASN UI panel ────────────────────────────────────────────────
  function createASNPanel(results) {
    const panelId = 'bgp-scraper-panel-asn';
    const existing = document.getElementById(panelId);
    if (existing) existing.remove();

    const accentColor = '#f59e0b'; // amber for ASN

    const panel = document.createElement('div');
    panel.id = panelId;
    panel.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 999999;
      background: #0f172a;
      color: #e2e8f0;
      font-family: 'Courier New', monospace;
      font-size: 13px;
      border: 1px solid #334155;
      border-radius: 8px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
      max-width: 560px;
      max-height: 70vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    `;

    const header = document.createElement('div');
    header.style.cssText = `
      padding: 10px 14px;
      background: #1e293b;
      border-bottom: 1px solid #334155;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
    `;
    header.innerHTML = `
      <span style="font-weight:bold; color:${accentColor};">
        🔢 ASN Results
        <span style="color:#94a3b8; font-weight:normal;"> (${results.length} found)</span>
      </span>
      <button id="bgp-close-btn-asn" style="
        background:none; border:none; color:#94a3b8;
        font-size:16px; cursor:pointer; padding:0 4px; line-height:1;
      ">✕</button>
    `;

    const list = document.createElement('div');
    list.style.cssText = `
      overflow-y: auto;
      padding: 10px 14px;
      flex: 1;
    `;

    if (results.length === 0) {
      list.innerHTML = `<div style="color:#f87171;">No ASN results found.</div>`;
    } else {
      results.forEach(r => {
        const item = document.createElement('div');
        item.style.cssText = `
          padding: 5px 0;
          border-bottom: 1px solid #1e293b;
          display: flex;
          gap: 10px;
          align-items: baseline;
        `;
        item.innerHTML = `
          <a href="${r.url}" target="_blank"
             style="color:${accentColor}; min-width:90px; text-decoration:none;">${r.asn}</a>
          ${r.description ? `<span style="color:#cbd5e1; font-size:11px;">${r.description}</span>` : ''}
        `;
        list.appendChild(item);
      });
    }

    const footer = document.createElement('div');
    footer.style.cssText = `
      padding: 10px 14px;
      background: #1e293b;
      border-top: 1px solid #334155;
      display: flex;
      gap: 8px;
      flex-shrink: 0;
      flex-wrap: wrap;
    `;

    const btnStyle = `
      padding: 6px 12px;
      border-radius: 5px;
      border: none;
      cursor: pointer;
      font-size: 12px;
      font-family: 'Courier New', monospace;
      font-weight: bold;
    `;

    // Copy just the ASN numbers (e.g. "AS7280")
    const copyAsnBtn = document.createElement('button');
    copyAsnBtn.textContent = '📋 Copy ASNs';
    copyAsnBtn.style.cssText = btnStyle + 'background:#f59e0b; color:#1e293b;';
    copyAsnBtn.onclick = () => {
      const text = results.map(r => r.asn).join('\n');
      GM_setClipboard(text);
      copyAsnBtn.textContent = '✅ Copied!';
      setTimeout(() => { copyAsnBtn.textContent = '📋 Copy ASNs'; }, 2000);
    };

    // Copy ASN numbers + their full links (tab separated, one per line)
    const copyLinksBtn = document.createElement('button');
    copyLinksBtn.textContent = '📋 Copy ASNs + Links';
    copyLinksBtn.style.cssText = btnStyle + 'background:#0ea5e9; color:#fff;';
    copyLinksBtn.onclick = () => {
      const text = results.map(r => `${r.asn}\t${r.url}`).join('\n');
      GM_setClipboard(text);
      copyLinksBtn.textContent = '✅ Copied!';
      setTimeout(() => { copyLinksBtn.textContent = '📋 Copy ASNs + Links'; }, 2000);
    };

    const csvBtn = document.createElement('button');
    csvBtn.textContent = '⬇ Export CSV';
    csvBtn.style.cssText = btnStyle + 'background:#10b981; color:#fff;';
    csvBtn.onclick = () => exportASNCSV(results);

    footer.appendChild(copyAsnBtn);
    footer.appendChild(copyLinksBtn);
    footer.appendChild(csvBtn);

    panel.appendChild(header);
    panel.appendChild(list);
    panel.appendChild(footer);
    document.body.appendChild(panel);

    document.getElementById('bgp-close-btn-asn').onclick = () => panel.remove();
  }

  // ─── Export helpers ────────────────────────────────────────────────────────
  function downloadFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportCSV(results, asNumber, ipVersion) {
    const header = 'Prefix,Visibility,Count,Description,IRR Status,ROA Status\n';
    const rows = results.map(r =>
      `"${r.prefix}","${r.percent}%","${r.count}","${r.description}","${r.irrStatus}","${r.roaStatus}"`
    ).join('\n');
    downloadFile(header + rows, `AS${asNumber}_ipv${ipVersion}_100pct_prefixes.csv`, 'text/csv');
  }

  function exportTXT(results, asNumber, ipVersion) {
    const lines = results.map(r => r.prefix).join('\n');
    downloadFile(lines, `AS${asNumber}_ipv${ipVersion}_100pct_prefixes.txt`, 'text/plain');
  }

  function exportASNCSV(results) {
    const header = 'ASN,Link,Description\n';
    const rows = results.map(r =>
      `"${r.asn}","${r.url}","${r.description}"`
    ).join('\n');
    downloadFile(header + rows, `bgp_search_asns.csv`, 'text/csv');
  }

  // ─── Inject a trigger button above a prefix table ──────────────────────────
  function injectButton(table, asNumber, ipVersion) {
    const btnId = `bgp-scrape-btn-${ipVersion}`;
    if (document.getElementById(btnId)) return; // already injected

    const isV6 = ipVersion === 6;
    const container = table.closest('div') || table.parentElement;

    const triggerBtn = document.createElement('button');
    triggerBtn.id = btnId;
    triggerBtn.textContent = isV6 ? '🌐 Extract IPv6 100% Prefixes' : '📡 Extract IPv4 100% Prefixes';
    triggerBtn.style.cssText = `
      display: block;
      margin: 10px 0;
      padding: 7px 16px;
      background: ${isV6 ? '#7c3aed' : '#0ea5e9'};
      color: #fff;
      border: none;
      border-radius: 5px;
      font-size: 13px;
      font-weight: bold;
      cursor: pointer;
      font-family: 'Courier New', monospace;
    `;

    triggerBtn.onclick = () => {
      const rows = table.querySelectorAll('tbody tr');
      const results = [];
      rows.forEach(row => {
        const data = parseRow(row);
        if (data) results.push(data);
      });
      console.log(`[BGP Scraper] AS${asNumber} IPv${ipVersion}: ${results.length} prefixes at 100% visibility`);
      createPanel(results, asNumber, ipVersion);
    };

    container.insertBefore(triggerBtn, table);
  }

  // ─── Inject a trigger button above a search-results table ──────────────────
  function injectASNButton(table) {
    const btnId = 'bgp-scrape-btn-asn';
    if (document.getElementById(btnId)) return; // already injected

    const container = table.closest('div') || table.parentElement;

    const triggerBtn = document.createElement('button');
    triggerBtn.id = btnId;
    triggerBtn.textContent = '🔢 Extract ASN Numbers + Links';
    triggerBtn.style.cssText = `
      display: block;
      margin: 10px 0;
      padding: 7px 16px;
      background: #f59e0b;
      color: #1e293b;
      border: none;
      border-radius: 5px;
      font-size: 13px;
      font-weight: bold;
      cursor: pointer;
      font-family: 'Courier New', monospace;
    `;

    triggerBtn.onclick = () => {
      const rows = table.querySelectorAll('tbody tr');
      const results = [];
      rows.forEach(row => {
        const data = parseASNRow(row);
        if (data) results.push(data);
      });
      console.log(`[BGP Scraper] Search results: ${results.length} ASN entries found`);
      createASNPanel(results);
    };

    container.insertBefore(triggerBtn, table);
  }

  // ─── Wait for a specific table by ID ──────────────────────────────────────
  function waitForTableById(id, callback, maxWait = 10000) {
    const start = Date.now();
    const interval = setInterval(() => {
      const table = document.getElementById(id);
      if (table) {
        clearInterval(interval);
        callback(table);
      } else if (Date.now() - start > maxWait) {
        clearInterval(interval);
      }
    }, 300);
  }

  // ─── Find the search-results table (no id) by detecting an ASN-type row ────
  function waitForSearchTable(callback, maxWait = 10000) {
    const start = Date.now();
    const interval = setInterval(() => {
      const tables = document.querySelectorAll('table');
      let found = null;
      tables.forEach(t => {
        if (found) return;
        // A search-results table has rows whose 2nd cell text is "ASN"
        const rows = t.querySelectorAll('tbody tr');
        for (const row of rows) {
          const cells = row.querySelectorAll('td');
          if (cells.length >= 2 && cells[1].textContent.trim() === 'ASN') {
            found = t;
            break;
          }
        }
      });
      if (found) {
        clearInterval(interval);
        callback(found);
      } else if (Date.now() - start > maxWait) {
        clearInterval(interval);
      }
    }, 300);
  }

  // ─── Entry point ──────────────────────────────────────────────────────────
  const path = window.location.pathname;

  if (/^\/AS\d+/i.test(path)) {
    // AS prefix page: handle IPv4 + IPv6 prefix tables
    const asMatch = path.match(/AS(\d+)/i);
    const asNumber = asMatch ? asMatch[1] : 'Unknown';

    // IPv4 table: id="rtprefixes-table"
    waitForTableById('rtprefixes-table', (table) => {
      injectButton(table, asNumber, 4);
    });

    // IPv6 table: id="rtprefixes-table-6" — only present on some ASNs
    waitForTableById('rtprefixes-table-6', (table) => {
      injectButton(table, asNumber, 6);
    });
  } else {
    // Search results page: extract ASN numbers + links
    waitForSearchTable((table) => {
      injectASNButton(table);
    });
  }

})();
