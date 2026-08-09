# Отчёт оценки качества

Дата прогона: 2026-08-09T11:59:40.386Z
Набор: 43 документов, из них размеченных: 15
Провайдеры: OCR — `mock`, LLM — `mock`
Версия схем: 1 (seed), правил: 13

## Метрики (ТЗ §12)

| Метрика | Значение | Цель |
| --- | --- | --- |
| Classification accuracy | 97.6% | ≥ 95% |
| Critical field exact match | 100% | ≥ 90% |
| Field coverage | 100% | ≥ 98% |
| Source coverage | 100% | публикуется как есть |
| Straight-through rate | 95.2% | публикуется как есть |
| False auto-approval | 0 | 0 на размеченном наборе |
| Median review time | не измеряется здесь | требует телеметрии оператора |

## Негативные сценарии

- Повреждённые файлы: отклонено 1 из 1
- Несколько документов в одном файле: предупреждений 1

## Как читать этот отчёт

Прогон выполнен на **mock-провайдерах**. Mock-LLM знает формат меток демо-набора, поэтому высокие значения извлечения означают исправность конвейера — сопоставления evidence → bbox, нормализации, валидации и маршрутизации, — но НЕ качество языковой модели. Оценка качества модели требует прогона с `LLM_PROVIDER=openai_compatible` и реальным ключом.

## Документы

| Файл | Тип | Итог | Критичные поля |
| --- | --- | --- | --- |
| invoice-001.pdf | invoice | автоматически | совпали |
| invoice-002.pdf | invoice | автоматически | совпали |
| invoice-003.pdf | invoice | автоматически | совпали |
| invoice-004.pdf | invoice | автоматически | совпали |
| invoice-005.pdf | invoice | автоматически | совпали |
| invoice-006.pdf | invoice | автоматически | совпали |
| invoice-007.pdf | invoice | автоматически | совпали |
| invoice-008.pdf | invoice | автоматически | совпали |
| invoice-009.pdf | invoice | автоматически | совпали |
| invoice-010.pdf | invoice | автоматически | совпали |
| invoice-011.pdf | invoice | автоматически | совпали |
| invoice-012.pdf | invoice | автоматически | совпали |
| bank_statement-001.pdf | bank_statement | автоматически | совпали |
| bank_statement-002.pdf | bank_statement | автоматически | совпали |
| bank_statement-003.pdf | bank_statement | автоматически | совпали |
| bank_statement-004.pdf | bank_statement | автоматически | совпали |
| bank_statement-005.pdf | bank_statement | автоматически | совпали |
| bank_statement-006.pdf | bank_statement | автоматически | совпали |
| bank_statement-007.pdf | bank_statement | автоматически | совпали |
| bank_statement-008.pdf | bank_statement | автоматически | совпали |
| bank_statement-009.pdf | bank_statement | автоматически | совпали |
| tax_letter-001.pdf | tax_letter | автоматически | совпали |
| tax_letter-002.pdf | tax_letter | автоматически | совпали |
| tax_letter-003.pdf | tax_letter | автоматически | совпали |
| tax_letter-004.pdf | tax_letter | автоматически | совпали |
| tax_letter-005.pdf | tax_letter | автоматически | совпали |
| tax_letter-006.pdf | tax_letter | автоматически | совпали |
| tax_letter-007.pdf | tax_letter | автоматически | совпали |
| tax_letter-008.pdf | tax_letter | автоматически | совпали |
| tax_letter-009.pdf | tax_letter | автоматически | совпали |
| contract-001.pdf | contract | автоматически | совпали |
| contract-002.pdf | contract | автоматически | совпали |
| contract-003.pdf | contract | автоматически | совпали |
| contract-004.pdf | contract | автоматически | совпали |
| contract-005.pdf | contract | автоматически | совпали |
| contract-006.pdf | contract | автоматически | совпали |
| contract-007.pdf | contract | автоматически | совпали |
| contract-008.pdf | contract | автоматически | совпали |
| contract-009.pdf | contract | автоматически | совпали |
| scan-low-quality.jpg | unknown | на проверку | — |
| duplicate-invoice.pdf | invoice | автоматически | совпали |
| corrupted.pdf | — | отклонён | — |
| multi-document.pdf | invoice | на проверку | совпали |
