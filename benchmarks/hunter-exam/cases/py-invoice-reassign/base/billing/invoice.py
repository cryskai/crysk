from dataclasses import dataclass, field


@dataclass
class LineItem:
    description: str
    unit_cents: int
    quantity: int = 1


@dataclass
class Invoice:
    invoice_id: str
    customer_id: str
    items: list[LineItem] = field(default_factory=list)
    status: str = "open"
    paid_cents: int = 0

    def __post_init__(self) -> None:
        if not self.items:
            raise ValueError("an invoice needs at least one line item")
        if any(i.unit_cents <= 0 or i.quantity <= 0 for i in self.items):
            raise ValueError("line items must have a positive amount")

    @property
    def total_cents(self) -> int:
        return sum(i.unit_cents * i.quantity for i in self.items)
