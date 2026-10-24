"""Small transport view; the canonical study and provenance stay server-side."""
from copy import deepcopy

FINANCIAL_FIELDS = ('FiscalYear', 'AsOfDataDate', 'Sales', 'EPS', 'PTP', 'BookValue', 'CashFlow',
                    'FreeCashFlow', 'SharesOut', 'PtpOnSales', 'ROE', 'DTC', 'EPSSplitFactor')
COMPANY_FIELDS = ('Ticker', 'CompanyName', 'CentralIndexKey', 'ExchangeType', 'Description', 'SectorDesc',
                  'IndustryDesc', 'LowPriceTtm', 'HighPriceTtm', 'MarketCap', 'beta', 'AverageVolume')


def fundamentals_view(document):
    def row_view(row, quarterly=False):
        values = {key: row.get(key) for key in FINANCIAL_FIELDS}
        # TTM FCF/share needs the share-weighting period, not full provenance.
        shares = (row.get('Sources') or {}).get('SharesOut')
        values['Sources'] = {'Sales': None, 'EPS': None, 'PTP': None,
                             'SharesOut': {key: shares.get(key) for key in ('Start', 'End')} if shares else None}
        if quarterly:
            values.update({'QuarterNo': row['QuarterNo'], 'Form': row.get('Form')})
        return values
    metadata = document['Metadata']
    return {
        'SchemaVersion': document['SchemaVersion'],
        'Study': {key: document['Study'].get(key) for key in ('StudyID', 'Ticker', 'DateCreated')},
        'Company': {key: document['Company'].get(key) for key in COMPANY_FIELDS},
        'AnnualData': [row_view(row) for row in document['AnnualData']],
        'QuarterlyData': [row_view(row, quarterly=True) for row in document.get('QuarterlyData', [])],
        'DailyPrices': deepcopy(document.get('DailyPrices', [])),
        'WeeklyPrices': deepcopy(document.get('WeeklyPrices', [])),
        'ComputedValues': deepcopy(document['ComputedValues']),
        'Metadata': {
            'DataStage': metadata.get('DataStage'), 'PriceInterval': metadata.get('PriceInterval', '1d'),
            'ResponseView': 'fundamentals', 'FinancialCurrency': metadata['FinancialCurrency'], 'PriceCurrency': metadata['PriceCurrency'],
            'Sources': deepcopy(metadata['Sources']), 'Warnings': list(metadata['Warnings']),
            'EPSAdjustment': {**{key: value for key, value in metadata['EPSAdjustment'].items() if key != 'Events'}, 'Events': []},
        },
    }


# All fields consumed by the chart, Fundamentals and Valuation. Export remains
# canonical and retains peers, full provenance, coverage and unused statements.
VALUATION_FIELDS = ('HighPrice', 'LowPrice', 'HighPE', 'LowPE', 'Dividend')


def study_view(document):
    result = fundamentals_view(document)
    result['Metadata']['ResponseView'] = 'study'
    result['Company']['Dividend'] = document['Company'].get('Dividend')
    for section in ('AnnualData', 'QuarterlyData'):
        for row, original in zip(result[section], document.get(section, [])):
            row.update({key: original.get(key) for key in VALUATION_FIELDS})
    return result
