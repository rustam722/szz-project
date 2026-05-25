// ═══════════════════════════════════════════════
// EXPORT.JS — CSV / Excel / Word
// ═══════════════════════════════════════════════

'use strict';

// ── Скачивание файла (браузер + pywebview) ───────
async function _download(blobOrUrl, filename) {
  // Pywebview: используем Python API для диалога сохранения
  if (window.pywebview?.api?.save_file) {
    try {
      let b64;
      if (typeof blobOrUrl === 'string' && blobOrUrl.startsWith('data:')) {
        b64 = blobOrUrl.split(',')[1];
      } else if (blobOrUrl instanceof Blob) {
        const buf = await blobOrUrl.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let bin = '';
        const chunk = 8192;
        for (let i = 0; i < bytes.length; i += chunk) {
          bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
        }
        b64 = btoa(bin);
      } else {
        // blob: URL → fetch → base64
        const r   = await fetch(blobOrUrl);
        const buf = await r.arrayBuffer();
        b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
      }
      await window.pywebview.api.save_file(filename, b64);
      return;
    } catch(e) { console.warn('pywebview save failed, fallback:', e); }
  }
  // Браузер: обычная ссылка
  const url = blobOrUrl instanceof Blob ? URL.createObjectURL(blobOrUrl) : blobOrUrl;
  const a   = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  setTimeout(() => { document.body.removeChild(a); if (blobOrUrl instanceof Blob) URL.revokeObjectURL(url); }, 1000);
}

function _today() { return new Date().toISOString().slice(0,10); }

// ── CSV ──────────────────────────────────────────
function exportCSV() {
  if (!foundParcels.length) return;
  const rows = [['№','Кадастровый номер','Адрес','Категория земель','Разрешенное использование','Площадь','Широта','Долгота','В СЗЗ','Функциональная зона']];
  foundParcels.forEach((r, i) => rows.push([
    i+1, r.cn, r.addr, r.cat, r.util, r.area,
    (r.lat||'').toFixed ? r.lat.toFixed(6) : r.lat,
    (r.lon||'').toFixed ? r.lon.toFixed(6) : r.lon,
    r.inP ? 'да' : 'пересечение', r.zone || ''
  ]));
  const csv = rows.map(r => r.map(c => `"${String(c ?? '').replace(/"/g,'""')}"`).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  _download(blob, `szz_parcels_${_today()}.csv`);
}

// ── Excel (XLSX) ─────────────────────────────────
async function exportExcel() {
  if (!foundParcels.length) return;
  if (!window.XLSX) { alert('Библиотека XLSX загружается, попробуйте через секунду'); return; }

  const btn = document.getElementById('btn-export-excel');
  if (btn) { btn.textContent = '⏳…'; btn.disabled = true; }

  try {
    const header = ['№','Кадастровый номер','Адрес','Категория земель',
                    'Разрешенное использование','Площадь','Широта','Долгота','В СЗЗ','Функциональная зона'];
    const data = [header, ...foundParcels.map((r, i) => [
      i+1, r.cn, r.addr, r.cat, r.util, r.area,
      (r.lat||'').toFixed ? +r.lat.toFixed(6) : r.lat,
      (r.lon||'').toFixed ? +r.lon.toFixed(6) : r.lon,
      r.inP ? 'да' : 'пересечение', r.zone || ''
    ])];

    const ws = XLSX.utils.aoa_to_sheet(data);
    // Ширина столбцов
    ws['!cols'] = [4,18,30,22,30,10,12,12,14,20].map(w => ({ wch: w }));
    // Заголовок жирный
    header.forEach((_, ci) => {
      const cell = ws[XLSX.utils.encode_cell({ r:0, c:ci })];
      if (cell) cell.s = { font: { bold: true }, fill: { fgColor: { rgb: 'BDD7EE' } } };
    });

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Участки в СЗЗ');
    const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    await _download(new Blob([wbout], { type: 'application/octet-stream' }), `szz_parcels_${_today()}.xlsx`);
    setSt(`Excel экспортирован: ${foundParcels.length} участков`, 'ok');
  } catch(e) {
    console.error('Excel export:', e);
    alert('Ошибка Excel: ' + e.message);
  }
  if (btn) { btn.textContent = '⬇ Excel'; btn.disabled = false; }
}

// ── Word (DOCX) ──────────────────────────────────
async function exportWord() {
  if (!foundParcels.length) return;
  if (!window.docx) { alert('Библиотека docx загружается, подождите...'); return; }

  const btn = document.getElementById('btn-export-word');
  if (btn) { btn.textContent = '⏳…'; btn.disabled = true; }

  try {
    const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
            AlignmentType, WidthType, BorderStyle, ShadingType, VerticalAlign,
            PageOrientation } = window.docx;

    const al = getActiveLayer();
    let cLat = 0, cLon = 0;
    if (al && al.poly) {
      cLat = al.poly.reduce((s,p) => s+p[0], 0) / al.poly.length;
      cLon = al.poly.reduce((s,p) => s+p[1], 0) / al.poly.length;
    } else {
      cLat = foundParcels.reduce((s,p) => s+p.lat, 0) / foundParcels.length;
      cLon = foundParcels.reduce((s,p) => s+p.lon, 0) / foundParcels.length;
    }

    const DIR_ORDER = [
      'На север от объекта','На северо-восток от объекта','На восток от объекта',
      'На юго-восток от объекта','На юг от объекта','На юго-запад от объекта',
      'На запад от объекта','На северо-запад от объекта',
    ];
    const grouped = {};
    DIR_ORDER.forEach(d => grouped[d] = []);
    foundParcels.forEach(p => {
      const dir = bearingToDir(getBearing(p.lat, p.lon, cLat, cLon));
      grouped[dir].push(p);
    });

    const F = 'Times New Roman', SZ = 20;
    const brd = { style: BorderStyle.SINGLE, size: 4, color: '000000' };
    const borders = { top: brd, bottom: brd, left: brd, right: brd };
    const cm = { top: 55, bottom: 55, left: 100, right: 100 };
    const W = [500, 1900, 2600, 5360, 2400];
    const TW = W.reduce((a,b) => a+b, 0);

    const mkCell = (text, width, opts = {}) => new TableCell({
      borders, width: { size: width, type: WidthType.DXA }, margins: cm,
      verticalAlign: VerticalAlign.CENTER,
      shading: opts.fill ? { fill: opts.fill, type: ShadingType.CLEAR } : undefined,
      children: [new Paragraph({
        alignment: opts.center ? AlignmentType.CENTER : AlignmentType.LEFT,
        children: [new TextRun({ text: String(text ?? ''), font: F, size: SZ, bold: opts.bold || false })]
      })]
    });

    const mkDirRow = text => new TableRow({
      children: [new TableCell({
        borders, columnSpan: 5, width: { size: TW, type: WidthType.DXA },
        margins: { top: 55, bottom: 55, left: 200, right: 100 },
        shading: { fill: 'DEEAF1', type: ShadingType.CLEAR },
        children: [new Paragraph({
          children: [new TextRun({ text, font: F, size: SZ, bold: true, italics: true, color: '1F3864' })]
        })]
      })]
    });

    const rows = [new TableRow({
      tableHeader: true,
      children: [
        mkCell('№ п/п', W[0], { fill: 'BDD7EE', bold: true, center: true }),
        mkCell('Кадастровый номер земельного участка', W[1], { fill: 'BDD7EE', bold: true, center: true }),
        mkCell('Категория земель', W[2], { fill: 'BDD7EE', bold: true, center: true }),
        mkCell('Вид разрешенного использования', W[3], { fill: 'BDD7EE', bold: true, center: true }),
        mkCell('Функциональная зона, согласно утвержденному генплану', W[4], { fill: 'BDD7EE', bold: true, center: true }),
      ]
    })];

    let counter = 1;
    for (const dir of DIR_ORDER) {
      const parcels = grouped[dir];
      if (!parcels.length) continue;
      rows.push(mkDirRow(dir));
      for (const p of parcels) {
        rows.push(new TableRow({ children: [
          mkCell(counter++, W[0], { center: true }),
          mkCell(p.cn,   W[1], { center: true }),
          mkCell(p.cat || '', W[2]),
          mkCell(p.util || '', W[3]),
          mkCell(p.zone || '', W[4]),
        ]}));
      }
    }

    const table = new Table({ width: { size: TW, type: WidthType.DXA }, columnWidths: W, rows });
    const szzName = al ? al.name : 'СЗЗ';

    const doc = new Document({ sections: [{ properties: { page: {
      size: { width: 11906, height: 16838, orientation: PageOrientation.LANDSCAPE },
      margin: { top: 1134, right: 851, bottom: 1134, left: 1701 },
    }}, children: [
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 },
        children: [new TextRun({ text: `Перечень земельных участков в границах ${szzName}`, font: F, size: 24, bold: true })]
      }),
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 300 },
        children: [new TextRun({ text: `Всего: ${foundParcels.length} уч. (внутри: ${foundParcels.filter(p=>p.inP).length}, пересечение: ${foundParcels.filter(p=>!p.inP).length})`, font: F, size: 20, color: '555555' })]
      }),
      table,
      new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { before: 200 },
        children: [new TextRun({ text: `Дата: ${new Date().toLocaleDateString('ru-RU')}`, font: F, size: 18, italics: true, color: '888888' })]
      }),
    ]}]});

    const buf  = await Packer.toBuffer(doc);
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    await _download(blob, `szz_parcels_${_today()}.docx`);
    setSt(`Word экспортирован: ${foundParcels.length} участков`, 'ok');
  } catch(e) {
    console.error('Word export:', e);
    alert('Ошибка экспорта Word: ' + e.message);
  }
  if (btn) { btn.textContent = '⬇ Word'; btn.disabled = false; }
}
