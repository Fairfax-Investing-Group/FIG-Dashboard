"""Fetch a bounded Yahoo-industry peer sample; never label it an industry universe."""
from concurrent.futures import ThreadPoolExecutor
from server.company_directory import indexes

from server.schema_fields import ANNUAL_FIELDS, AVERAGE_FIELDS
from server.study_schema import finite, growth_rate
from server.market import peer_limit


def peer_averages(documents, currency):
    members = [document for document in documents if document['Metadata']['FinancialCurrency'] == currency]
    years = sorted({row['FiscalYear'] for document in members for row in document['AnnualData']})
    result = []
    for year in years:
        rows = [row for document in members for row in document['AnnualData'] if row['FiscalYear'] == year]
        record = dict.fromkeys(ANNUAL_FIELDS)
        counts = {}
        for field in ANNUAL_FIELDS:
            if field == 'FiscalYear' or field.endswith('Outlier') or field in {'NoDataForYear', 'DataLocked'}:
                continue
            numbers = [row[field] for row in rows if finite(row.get(field)) is not None]
            if numbers:
                record[field] = sum(numbers) / len(numbers)
                counts[field] = len(numbers)
        record.update({'FiscalYear': year, 'ObservationCounts': counts})
        result.append(record)
    rates = dict.fromkeys(AVERAGE_FIELDS)
    for key in ('Sales', 'EPS', 'PTP'):
        rates[f'{key}GrowthRate'] = growth_rate(result, key)
    for key in ('PtpOnSales', 'ROE', 'DTC', 'TotalDebt', 'HighPE', 'LowPE', 'Payout', 'TotalAssets'):
        values = [row[key] for row in result if row.get(key) is not None]
        rates[f'{key}Avg'] = sum(values) / len(values) if values else None
    return result, rates


def add_peers(document, symbols):
    limit = peer_limit()
    if not symbols or not limit:
        document['Metadata']['PeerGroup'] = {'Method': 'Yahoo industry top-company sample', 'Members': [], 'NotIndustryAverage': True}
        return
    from server.studies import ROOT, create_study
    lookup = indexes()[1]
    seen = {int(document['Company']['CentralIndexKey'])}
    companies, skipped = [], []
    for symbol in symbols:
        company = lookup.get(symbol)
        if not company:
            skipped.append(symbol)
        elif company['cik'] not in seen:
            companies.append(company)
            seen.add(company['cik'])
        if len(companies) == limit:
            break
    peers, errors = [], []
    with ThreadPoolExecutor(max_workers=3) as executor:
        futures = [(company, executor.submit(create_study, company, include_peers=False, persist=False)) for company in companies]
        for company, future in futures:
            try:
                peer = future.result()
                if not peer['AnnualData']:
                    errors.append(company['ticker'])
                    continue
                peers.append(peer)
            except Exception:
                errors.append(company['ticker'])
    document['Peers'] = [{'PeerCompany': peer['Company'], 'AnnualPeerData': peer['AnnualData'], 'QuarterlyPeerData': peer['QuarterlyData'],
                          'AvgsAndRates': {key: peer['ComputedValues'].get(key) for key in AVERAGE_FIELDS}, 'Metadata': peer['Metadata']} for peer in peers]
    if peers:
        group = [document, *peers]
        document['PeerGroupAverage'], document['PeerGroupAvgsAndRates'] = peer_averages(group, document['Metadata']['FinancialCurrency'])
        document['Metadata']['UnavailableSections'] = [key for key in document['Metadata']['UnavailableSections'] if key not in {'Peers', 'PeerGroupAverage'}]
        document['Metadata']['AvailableSections'].extend(['Peers', 'PeerGroupAverage'])
    document['Metadata']['PeerGroup'] = {'Method': 'arithmetic mean per field/year, available observations only; focal company plus Yahoo industry top-company sample',
                                       'Members': [document['Company']['Ticker'], *[peer['Company']['Ticker'] for peer in peers]],
                                       'Currency': document['Metadata']['FinancialCurrency'], 'SkippedSymbols': skipped, 'FailedSymbols': errors,
                                       'NotIndustryAverage': True, 'CrossCurrencyCompaniesExcludedFromAverages': [peer['Company']['Ticker'] for peer in peers if peer['Metadata']['FinancialCurrency'] != document['Metadata']['FinancialCurrency']]}
    if errors:
        document['Metadata']['Warnings'].append(f"Peer data could not be loaded for {', '.join(errors)}.")
