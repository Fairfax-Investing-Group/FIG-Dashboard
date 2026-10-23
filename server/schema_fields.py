"""Field names from the requested study JSON contract; no example values are stored."""

STUDY_FIELDS = ('StudyID', 'IssueId', 'DailyDateId', 'DailyDateIdFormatted', 'DailyCompanyId', 'StudyName',
 'CreatedBy', 'Comment', 'PreparedBy', 'Saved', 'Ticker', 'IsCompleted', 'ProjectionLineStart',
 'ProjSalesGrowthRate', 'ProjEpsSelection', 'ProjEpsGrowthRate', 'ProjPtpMarginRate', 'ProjTaxRate',
 'ProjPrefDividend', 'ProjSharesOutstanding', 'ProjHighPriceSelection', 'ProjHighPE', 'ProjHighEps',
 'ProjLowPriceSelection', 'ProjLowStockPrice', 'ProjAvgLowPE', 'ProjLowEps', 'ProjAvgPayoutRate',
 'Zoning', 'EstimatedTaxRate', 'DateCreated', 'ModifiedBy', 'DateModified', 'LowEPSUpdateMethod',
 'DateJudgmentsModified', 'NewsletterCode')

COMPANY_FIELDS = ('Ticker', 'DailyCompanyId', 'DailyDateId', 'IssueId', 'CompanyName', 'WebURL', 'Size',
 'SectorCode', 'SectorDesc', 'IndustryCode', 'IndustryDesc', 'GroupType', 'Description',
 'ExchangeType', 'DatasourceType', 'BasicShares', 'Dividend', 'ClosingPrice', 'DateOfClosingPrice',
 'AnalystEPSEstGrowthRate', 'AnalystEPSEstGrowthAmt', 'FiscalYearLast', 'FYMonth', 'TotalDebt',
 'PrefStock', 'PrefDiv', 'DilutedShares', 'QualitySource', 'QualityRating', 'InsiderOwnershipPct',
 'InstitutionalOwnershipPct', 'InterestCoverageQuarterLast', 'SIC', 'StockRank', 'beta',
 'EpsCurrentAnalystEst', 'RawAdjFactor', 'FullName', 'IndicatedDividend', 'HighPriceTtm',
 'LowPriceTtm', 'AnalystSalesEstGrowthRate', 'AnalystSalesEstGrowthAmt', 'ADR',
 'CashEquivQuarterLast', 'CashEquivQuarterYearAgo', 'PreferredSharesLastQuarter',
 'ReceivablesQuarterLast', 'ReceivablesQuarterYearAgo', 'InventoriesQuarterLast',
 'InventoriesQuarterYearAgo', 'CurrentAssetsQuarterLast', 'CurrentAssetsQuarterYearAgo',
 'ShortTermDebtQuarterLast', 'ShortTermDebtQuarterYearAgo', 'LiabilitiesQuarterLast',
 'LiabilitiesQuarterYearAgo', 'CapitalizationQuarterYearAgo', 'AssetsQuarterLast', 'YearAgo',
 'YearAgoQuarter', 'YearLast', 'QuarterLast', 'QuarterLastDataDate', 'DateOfLastQuarter', 'Country',
 'TotalDebtQuarterLast', 'IsBank', 'CentralIndexKey', 'NumOfSalesAvgEst', 'NumOfEpsAvgEst',
 'DataSource', 'DataStatus', 'DataLocked', 'AnalystSalesEstUseBlank', 'NumOfSalesEstUseBlank',
 'AnalystEpsEstUseBlank', 'NumOfEpsEstUseBlank', 'DataSourceUseBlank', 'FinancialScore',
 'CurrRatioLQ', 'QuickRatioLQ', 'InterestCvgTTM', 'TotalRevenueTTM', 'CostofRevenueTTM',
 'OperatingIncomeTTM', 'PretaxIncomeTTM', 'OperatingCashFlowTTM', 'NetIncomeCommonTTM',
 'FreeCashFlowTTM', 'CommonStockEquityQuarterLast', 'TotalAssetsQuarterLast',
 'CurrentRatioQuarterLast', 'QuickRatioQuarterLast', 'GoodwillQuarterLast', 'IsREIT')

ANNUAL_FIELDS = ('FiscalYear', 'Sales', 'EPS', 'PTP', 'PtpOnSales', 'ROE', 'DTC', 'SharesOut', 'Dividend',
 'BookValue', 'NetIncome', 'CashFlow', 'LtDebt', 'TotalDebt', 'HighPrice', 'LowPrice', 'HighPE',
 'LowPE', 'TaxRate', 'Payout', 'TotalAssets', 'TotalAssetsBegin', 'SalesOutlier', 'EPSOutlier',
 'PTPOutlier', 'PtpOnSalesOutlier', 'ROEOutlier', 'DTCOutlier', 'SharesOutOutlier',
 'DividendOutlier', 'BookValueOutlier', 'NetIncomeOutlier', 'CashFlowOutlier', 'TotalDebtOutlier',
 'PricesOutlier', 'TaxRateOutlier', 'HighPEOutlier', 'LowPEOutlier', 'PayoutOutlier',
 'TotalAssetsOutlier', 'ROAAOutlier', 'NoDataForYear', 'DataStatus', 'DataLocked', 'CurrentRatio',
 'QuickRatio', 'InterestCoverage', 'TotalRevenue', 'CostofRevenue', 'OperatingIncome',
 'PretaxIncome', 'NetIncomeCommon', 'OperatingCashFlow', 'FreeCashFlow', 'AccountsReceivable',
 'Inventory', 'CommonStockEquity', 'Goodwill', 'AsOfDataDate')

SCALE_FIELDS = ('EPS', 'Sales', 'Price', 'PTP', 'Dividend', 'SharesOut', 'BookValue', 'NetIncome', 'CashFlow',
 'TotalDebt', 'TotalAssets')

AVERAGE_FIELDS = ('SalesGrowthRate', 'EPSGrowthRate', 'PTPGrowthRate', 'PtpOnSalesAvg', 'ROEAvg', 'DTCAvg',
 'TotalDebtAvg', 'HighPEAvg', 'LowPEAvg', 'PayoutAvg', 'TotalAssetsAvg')

