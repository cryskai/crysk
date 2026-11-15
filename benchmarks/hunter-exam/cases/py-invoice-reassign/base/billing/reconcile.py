from dataclasses import dataclass

from billing.store import InvoiceStore


@dataclass
class Payment:
    customer_id: str
    amount_cents: int


def reconcile(store: InvoiceStore, payments: list[Payment]) -> list[str]:
    """Apply each payment to the customer's open invoices, oldest first.

    Returns the ids of the invoices that became fully paid.
    """
    settled: list[str] = []
    for payment in payments:
        remaining = payment.amount_cents
        for invoice in store.for_customer(payment.customer_id):
            if remaining <= 0:
                break
            if invoice.status != "open":
                continue
            due = invoice.total_cents - invoice.paid_cents
            applied = min(due, remaining)
            invoice.paid_cents += applied
            remaining -= applied
            if invoice.paid_cents == invoice.total_cents:
                invoice.status = "paid"
                settled.append(invoice.invoice_id)
    return settled
