"""Read the supplied dashboard's cached values without executing workbook formulas.
Usage: python3 scripts/importDashboard.py path/to/workbook.xlsx
"""
import argparse
from datetime import datetime, timedelta
import json
from pathlib import Path
import xml.etree.ElementTree as ET
from zipfile import ZipFile

NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}


def read_sheets(path):
    with ZipFile(path) as archive:
        shared = [''.join(item.itertext()) for item in ET.fromstring(archive.read('xl/sharedStrings.xml'))]
        rels = {item.attrib['Id']: item.attrib['Target'] for item in ET.fromstring(archive.read('xl/_rels/workbook.xml.rels'))}
        result = {}
        for sheet in ET.fromstring(archive.read('xl/workbook.xml')).find('m:sheets', NS):
            target = rels[sheet.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']]
            target = target.lstrip('/') if target.startswith('/') else 'xl/' + target
            cells = {}
            for cell in ET.fromstring(archive.read(target)).findall('.//m:sheetData/m:row/m:c', NS):
                value = cell.find('m:v', NS)
                if value is None or value.text is None:
                    continue
                text = value.text
                if cell.attrib.get('t') == 's':
                    value = shared[int(text)]
                elif cell.attrib.get('t') in {'str', 'e'}:
                    value = text
                else:
                    value = float(text)
                cells[cell.attrib['r']] = value
            result[sheet.attrib['name']] = cells
        logo = archive.read('xl/media/image1.png') if 'xl/media/image1.png' in archive.namelist() else None
    return result, logo


def iso_date(value):
    if isinstance(value, (float, int)):
        return (datetime(1899, 12, 30) + timedelta(days=value)).date().isoformat()
    return datetime.strptime(value.split(' ')[0], '%m/%d/%Y').date().isoformat()


def number(value):
    return isinstance(value, (int, float))


def build_dashboard(sheets, filename):
    main, daily = sheets['Dashboard'], sheets['Sheet10']
    as_of_text = main['D3'].replace('Last Updated: ', '').strip()
    as_of = datetime.strptime(as_of_text.replace(' ET', ''), '%m/%d/%Y %I:%M %p')
    cutoff = (as_of - timedelta(days=90)).date().isoformat()
    def series(cells, date_column, value_column, first, last, recent=False):
        points = []
        for row in range(first, last + 1):
            day, value = cells.get(f'{date_column}{row}'), cells.get(f'{value_column}{row}')
            if day is not None and number(value):
                date = iso_date(day)
                if not recent or date >= cutoff:
                    points.append({'date': date, 'value': value})
        return points
    holdings = []
    for row, column in zip(range(19, 29), ['C', 'E', 'G', 'I', 'L', 'N', 'P', 'R', 'T', 'V']):
        added = main[f'E{row}']
        holdings.append({
            'ticker': main[f'B{row}'], 'name': main[f'C{row}'], 'purchaseDate': iso_date(added),
            'purchaseNote': 'avg down' if isinstance(added, str) and '(avg down)' in added else None,
            **{key: main[f'{col}{row}'] for key, col in [('price', 'F'), ('averageCost', 'H'), ('shares', 'I'), ('cost', 'J'), ('marketValue', 'K'), ('gain', 'M'), ('return', 'N'), ('dayChange', 'O'), ('weight', 'P'), ('high52', 'R'), ('low52', 'S')]},
            'history': series(daily, 'B', column, 12, 199, True),
        })
    performance = []
    for row in range(12, 200):
        day, club, benchmark = daily.get(f'AG{row}'), daily.get(f'AH{row}'), daily.get(f'AI{row}')
        if day is not None and number(club) and number(benchmark):
            performance.append({'date': iso_date(day), 'club': club, 'benchmark': benchmark})
    # The last daily row has closes but no cached returns. Use the dashboard's
    # explicitly dated totals for that final point, rather than inventing returns.
    if performance and performance[-1]['date'] < as_of.date().isoformat():
        performance.append({'date': as_of.date().isoformat(), 'club': main['P3'], 'benchmark': main['R3']})
    partners = []
    for row, sheet_name in zip(range(33, 37), ['T.Duong', 'T.Er', 'K.Li', 'C.Mo']):
        sheet = sheets[sheet_name]
        pitches = [{'ticker': sheet[f'E{r}'], 'date': iso_date(sheet[f'F{r}']), **{key: sheet[f'{col}{r}'] for key, col in [('pitchPrice', 'G'), ('price', 'H'), ('shares', 'I'), ('cost', 'J'), ('marketValue', 'K'), ('gain', 'L'), ('return', 'M')]}} for r in range(5, 9)]
        partners.append({'name': main[f'B{row}'], 'tickers': main[f'C{row}'], 'return': main[f'E{row}'], 'pitches': pitches})
    pulse = []
    for row, columns in zip(range(33, 37), [('A', 'B'), ('I', 'J'), ('E', 'F'), None]):
        history = series(sheets['Sheet9'], *columns, 3, 128, True) if columns else [{'date': iso_date(sheets['Charts'][f'{col}87']), 'value': sheets['Charts'][f'{col}91']} for col in 'BCDEFGHIJKLMN' if number(sheets['Charts'].get(f'{col}91')) and iso_date(sheets['Charts'][f'{col}87']) >= cutoff]
        pulse.append({'ticker': main[f'L{row}'], 'name': main[f'M{row}'], 'dayChange': main[f'N{row}'], 'history': history})
    indexes = [{'name': main[f'Q{row}'], 'price': main[f'R{row}'], 'history': series(daily, 'B', 'AB', 12, 198, True) if row == 34 else []} for row in range(33, 37)]
    return {'source': filename, 'asOf': as_of.date().isoformat(), 'updatedLabel': as_of_text,
            'summary': {key: main[cell] for key, cell in [('portfolioValue', 'I3'), ('cash', 'K3'), ('totalCost', 'M3'), ('holdingsValue', 'N3'), ('portfolioReturn', 'P3'), ('benchmarkReturn', 'R3'), ('relativeReturn', 'S3'), ('gain', 'T3')]},
            'holdings': holdings, 'performance': performance, 'partners': partners, 'marketPulse': pulse, 'indexes': indexes,
            'riskKey': [{'color': 'green', 'meaning': main['H33'].strip()}, {'color': 'yellow', 'meaning': main['H34'].strip()}, {'color': 'blue', 'meaning': main['H35'].strip()}]}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('workbook', type=Path)
    args = parser.parse_args()
    sheets, logo = read_sheets(args.workbook)
    dashboard = build_dashboard(sheets, args.workbook.name)
    destination = Path(__file__).resolve().parents[1] / 'src/data/portfolio.json'
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(dashboard, indent=2, allow_nan=False) + '\n')
    if logo:
        assets = destination.parents[1] / 'assets'
        assets.mkdir(exist_ok=True)
        (assets / 'fairfax-logo.png').write_bytes(logo)
    print(f'Imported {len(dashboard["holdings"])} holdings, {len(dashboard["performance"])} return observations, and {len(dashboard["partners"])} partners.')
