# billing

In-memory invoicing for a small back office.

- `InvoiceStore` keeps invoices by id and a per-customer listing.
- `reconcile` applies customer payments to that customer's open invoices.
- `export` renders a customer's invoices as rows; `list` and `export` share the
  global `--page` and `--page-size` options.
- A voided invoice stays retrievable by id and leaves its customer's listing.
