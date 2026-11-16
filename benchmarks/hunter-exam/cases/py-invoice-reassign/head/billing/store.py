from billing.invoice import Invoice


class InvoiceStore:
    def __init__(self) -> None:
        self._invoices: dict[str, Invoice] = {}
        self._by_customer: dict[str, list[str]] = {}

    def add(self, invoice: Invoice) -> None:
        if invoice.invoice_id in self._invoices:
            raise KeyError(f"duplicate invoice {invoice.invoice_id}")
        self._invoices[invoice.invoice_id] = invoice
        self._index(invoice)

    def get(self, invoice_id: str) -> Invoice | None:
        return self._invoices.get(invoice_id)

    def remove(self, invoice_id: str) -> None:
        invoice = self._invoices.pop(invoice_id)
        self._unindex(invoice)

    def reassign(self, invoice_id: str, customer_id: str) -> Invoice:
        invoice = self._invoices[invoice_id]
        if invoice.status == "void":
            raise ValueError("a voided invoice cannot be reassigned")
        if invoice.customer_id == customer_id:
            return invoice
        invoice.customer_id = customer_id
        self._unindex(invoice)
        self._index(invoice)
        return invoice

    def void(self, invoice_id: str) -> Invoice:
        invoice = self._invoices[invoice_id]
        if invoice.status == "paid":
            raise ValueError("a paid invoice cannot be voided")
        invoice.status = "void"
        self._unindex(invoice)
        return invoice

    def for_customer(self, customer_id: str) -> list[Invoice]:
        ids = self._by_customer.get(customer_id, [])
        return [self._invoices[i] for i in ids]

    def _index(self, invoice: Invoice) -> None:
        self._by_customer.setdefault(invoice.customer_id, []).append(
            invoice.invoice_id
        )

    def _unindex(self, invoice: Invoice) -> None:
        ids = self._by_customer.get(invoice.customer_id, [])
        if invoice.invoice_id in ids:
            ids.remove(invoice.invoice_id)
