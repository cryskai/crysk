import argparse
import json

from billing.export import export_page
from billing.paging import page_slice
from billing.store import InvoiceStore


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="billing")
    parser.add_argument(
        "--page", type=int, default=1, help="page number, starting at 1"
    )
    parser.add_argument("--page-size", type=int, default=50)
    sub = parser.add_subparsers(dest="command", required=True)
    listing = sub.add_parser("list")
    listing.add_argument("customer_id")
    export = sub.add_parser("export")
    export.add_argument("customer_id")
    return parser


def run(store: InvoiceStore, argv: list[str]) -> str:
    args = build_parser().parse_args(argv)
    if args.command == "list":
        invoices = store.for_customer(args.customer_id)
        page = page_slice(invoices, args.page, args.page_size)
        return "\n".join(i.invoice_id for i in page)
    rows = export_page(store, args.customer_id, args.page, args.page_size)
    return json.dumps(rows)
