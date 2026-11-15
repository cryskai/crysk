from billing.money import format_cents
from billing.store import InvoiceStore


def export_customer(store: InvoiceStore, customer_id: str) -> list[dict]:
    return [
        {
            "invoice": invoice.invoice_id,
            "status": invoice.status,
            "total": format_cents(invoice.total_cents),
            "paid": format_cents(invoice.paid_cents),
        }
        for invoice in store.for_customer(customer_id)
    ]
