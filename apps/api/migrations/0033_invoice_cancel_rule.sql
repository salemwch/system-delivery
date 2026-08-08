-- Fixes a contradiction between two rules introduced in 0032.
--
-- ⚠️ THE BUG. `invoices_number_chk` requires a CANCELLED invoice to have a NULL
-- number, while `invoices_enforce_immutability()` permitted ISSUED → CANCELLED.
-- An issued invoice HAS a number, so that transition could never succeed: the
-- trigger waved it through and the CHECK constraint then rejected it with
-- `check_violation` and a message about the number column — an error that
-- describes a symptom nowhere near the cause.
--
-- Only one of the two can stay, and the CHECK is the one that is right:
--
--   A number that has been issued has been REPORTED. Releasing it back, or
--   keeping it on a row that claims the document never existed, both put the
--   series into a state an auditor reads as a destroyed invoice. An issued
--   invoice is corrected by a CREDIT NOTE — that is the entire reason credit
--   notes exist, and allowing a quiet cancellation instead would make the avoir
--   path optional in practice.
--
-- So ISSUED now has exactly ONE successor: PAID. The service already refuses to
-- cancel anything but a draft (`InvoiceService.cancelDraft`); this makes the
-- database agree, so a direct SQL update cannot do what the API forbids.
--
-- Forward-only: 0032 has been applied, so its function is REPLACEd rather than
-- edited. The trigger keeps pointing at the same name and needs no change.

CREATE OR REPLACE FUNCTION invoices_enforce_immutability() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF OLD.status = 'DRAFT' THEN
    RETURN NEW;  -- A draft is a working document.
  END IF;

  -- The ONLY permitted transition after issue. See the header: cancellation is
  -- not among them, because the number has already been reported.
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'ISSUED' AND NEW.status = 'PAID') THEN
    RAISE EXCEPTION
      'invoice % is % and cannot become %; correct it with a credit note',
      OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- Everything that defines the document as a tax record.
  IF NEW.number          IS DISTINCT FROM OLD.number
     OR NEW.number_year  IS DISTINCT FROM OLD.number_year
     OR NEW.kind         IS DISTINCT FROM OLD.kind
     OR NEW.merchant_id  IS DISTINCT FROM OLD.merchant_id
     OR NEW.currency     IS DISTINCT FROM OLD.currency
     OR NEW.issued_at    IS DISTINCT FROM OLD.issued_at
     OR NEW.subtotal_minor    IS DISTINCT FROM OLD.subtotal_minor
     OR NEW.vat_rate_bp       IS DISTINCT FROM OLD.vat_rate_bp
     OR NEW.vat_amount_minor  IS DISTINCT FROM OLD.vat_amount_minor
     OR NEW.stamp_duty_minor  IS DISTINCT FROM OLD.stamp_duty_minor
     OR NEW.total_minor       IS DISTINCT FROM OLD.total_minor
     OR NEW.seller_name  IS DISTINCT FROM OLD.seller_name
     OR NEW.seller_tax_id IS DISTINCT FROM OLD.seller_tax_id
     OR NEW.buyer_name   IS DISTINCT FROM OLD.buyer_name
     OR NEW.buyer_tax_id IS DISTINCT FROM OLD.buyer_tax_id
     OR NEW.period_from  IS DISTINCT FROM OLD.period_from
     OR NEW.period_to    IS DISTINCT FROM OLD.period_to
     OR NEW.corrects_invoice_id IS DISTINCT FROM OLD.corrects_invoice_id THEN
    RAISE EXCEPTION
      'invoice % has been issued and is immutable; correct it with a credit note', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION invoices_enforce_immutability() IS
  'An issued invoice may only become PAID. Cancellation is a draft-only action; '
  'an issued document is corrected by a credit note, never withdrawn.';
