from billing.money import format_cents
from billing.store import InvoiceStore


def export_customer(store: InvoiceStore, customer_id: str) -> list[dict]:
    return [
        {
            "invoice": invoice.invoice_id,
            "status": invoice.status,
            "total": format_cents(invoice.total_cents),
            "paid": format_cents(invoice.paid_cents),
            "progress": f"{invoice.paid_ratio:.0%}",
        }
        for invoice in store.for_customer(customer_id)
    ]


def export_page(
    store: InvoiceStore, customer_id: str, page: int, page_size: int
) -> list[dict]:
    rows = export_customer(store, customer_id)
    start = page * page_size
    return rows[start : start + page_size]
