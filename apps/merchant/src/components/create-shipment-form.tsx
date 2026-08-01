"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { BUTTON_CLASS, Field, INPUT_CLASS } from "./ui";
import { createShipment } from "@/lib/actions";
import { EMPTY_FORM_STATE } from "@/lib/form-state";
import { MESSAGES } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";
import type { AddressBookEntry } from "@/lib/queries";

/**
 * The create-parcel form — the action this portal exists for.
 *
 * A client component for three reasons and no others: pending state so the
 * button cannot be double-tapped, per-field errors without a round trip, and
 * one-tap autofill from the address book. The submission itself goes to a server
 * action; no credentials or API addresses are involved here.
 *
 * ⚠️ COD is entered in MAJOR units ("12,500") and converted using the currency's
 * own exponent on the server. Asking a merchant for millimes would be absurd,
 * and converting with a hardcoded ×100 would misprice every Tunisian parcel by
 * a factor of ten.
 */
export function CreateShipmentForm({
  locale,
  currencyCode,
  currencyExponent,
  addressBook,
}: {
  locale: Locale;
  currencyCode: string;
  currencyExponent: number;
  addressBook: readonly AddressBookEntry[];
}) {
  const messages = MESSAGES[locale];
  const [state, action] = useActionState(
    createShipment.bind(null, locale, currencyExponent),
    EMPTY_FORM_STATE,
  );

  // Controlled only so the address book can fill them. Everything else is
  // uncontrolled, which keeps typing free of re-renders on a cheap phone.
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");

  function fillFrom(entry: AddressBookEntry): void {
    setName(entry.recipientName);
    setPhone(entry.recipientPhone);
    setAddress(entry.rawInput);
    setCity(entry.city ?? "");
  }

  const errorFor = (field: string): string | undefined => {
    const code = state.fieldErrors[field];
    if (code === undefined) return undefined;
    return code === "required"
      ? messages.recipientName
      : code === "format"
        ? messages.recipientPhoneHint
        : code;
  };

  return (
    <form action={action} className="space-y-6">
      {state.error !== null && Object.keys(state.fieldErrors).length === 0 ? (
        <p
          role="alert"
          className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm font-medium text-red-800"
        >
          {messages.somethingWentWrong}
        </p>
      ) : null}

      {addressBook.length > 0 ? (
        <section>
          <h2 className="text-sm font-semibold text-slate-800">{messages.useSavedAddress}</h2>
          <p className="mt-0.5 text-xs text-slate-500">{messages.savedAddressHint}</p>
          <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
            {addressBook.slice(0, 12).map((entry) => (
              <button
                key={`${entry.recipientPhone}-${entry.addressId}`}
                type="button"
                onClick={() => {
                  fillFrom(entry);
                }}
                className="min-h-11 shrink-0 rounded-lg border border-slate-300 bg-white px-3 py-2 text-start text-xs hover:border-brand"
              >
                <span className="block font-medium">{entry.recipientName}</span>
                <span className="ltr-isolate block text-slate-500">{entry.recipientPhone}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-slate-800">{messages.recipientDetails}</h2>

        <Field label={messages.recipientName} name="recipientName" error={errorFor("recipientName")}>
          <input
            id="recipientName"
            name="recipientName"
            required
            maxLength={200}
            autoComplete="name"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
            className={INPUT_CLASS}
          />
        </Field>

        <Field
          label={messages.recipientPhone}
          name="recipientPhone"
          hint={messages.recipientPhoneHint}
          error={errorFor("recipientPhone")}
        >
          <input
            id="recipientPhone"
            name="recipientPhone"
            type="tel"
            required
            // The phone keyboard on a mobile, and LTR even on an Arabic page —
            // a mirrored number gets dialled wrong.
            inputMode="tel"
            dir="ltr"
            autoComplete="tel"
            value={phone}
            onChange={(event) => {
              setPhone(event.target.value);
            }}
            className={INPUT_CLASS}
          />
        </Field>
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-slate-800">{messages.deliveryAddress}</h2>

        <Field
          label={messages.deliveryAddress}
          name="addressLine"
          hint={messages.addressHint}
          error={errorFor("addressLine")}
        >
          <textarea
            id="addressLine"
            name="addressLine"
            required
            rows={2}
            maxLength={500}
            value={address}
            onChange={(event) => {
              setAddress(event.target.value);
            }}
            className={INPUT_CLASS}
          />
        </Field>

        <Field label={messages.city} name="city">
          <input
            id="city"
            name="city"
            maxLength={120}
            autoComplete="address-level2"
            value={city}
            onChange={(event) => {
              setCity(event.target.value);
            }}
            className={INPUT_CLASS}
          />
        </Field>

        <Field label={messages.notes} name="notes" hint={messages.notesHint}>
          <input id="notes" name="notes" maxLength={500} className={INPUT_CLASS} />
        </Field>
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-slate-800">{messages.parcelDetails}</h2>

        <Field
          label={`${messages.codAmount} (${currencyCode})`}
          name="codAmount"
          hint={messages.codAmountHint}
          error={state.fieldErrors["codAmount"] === undefined ? undefined : messages.codAmountHint}
        >
          <input
            id="codAmount"
            name="codAmount"
            // `decimal` rather than `numeric`: the merchant needs a separator key
            // on a phone keypad to type 12,500.
            inputMode="decimal"
            dir="ltr"
            placeholder="0"
            maxLength={30}
            className={INPUT_CLASS}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label={messages.weight} name="weightGrams" hint={messages.weightHint}>
            <input
              id="weightGrams"
              name="weightGrams"
              type="number"
              inputMode="numeric"
              min={0}
              max={1000000}
              dir="ltr"
              className={INPUT_CLASS}
            />
          </Field>

          <Field label={messages.parcelCount} name="parcelCount">
            <input
              id="parcelCount"
              name="parcelCount"
              type="number"
              inputMode="numeric"
              min={1}
              max={100}
              defaultValue={1}
              dir="ltr"
              className={INPUT_CLASS}
            />
          </Field>
        </div>
      </section>

      <SubmitButton idle={messages.create} busy={messages.creating} />
    </form>
  );
}

/**
 * Disabled while submitting.
 *
 * The idempotency key makes a duplicate submission harmless server-side; this
 * makes it not happen in the first place, and tells the merchant something is
 * in flight on a slow connection.
 */
function SubmitButton({ idle, busy }: { idle: string; busy: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={`${BUTTON_CLASS} w-full`}>
      {pending ? busy : idle}
    </button>
  );
}
