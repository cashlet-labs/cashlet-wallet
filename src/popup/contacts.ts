import type { BchNetwork } from "@cashlet-labs/bnd";
import { parseDestination } from "../wallet/address";

export interface Contact {
  id: string;
  name: string;
  address: string;
  network: BchNetwork;
}

const KEY = "contacts";

function valid(value: unknown): value is Contact {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.id === "string" &&
    typeof c.name === "string" &&
    typeof c.address === "string" &&
    (c.network === "mainnet" || c.network === "chipnet")
  );
}

/** Contacts are not secret; they live in extension storage, checked when read. */
export async function loadContacts(): Promise<Contact[]> {
  const stored = (await chrome.storage.local.get(KEY))[KEY];
  return Array.isArray(stored) ? stored.filter(valid) : [];
}

export async function saveContact(
  name: string,
  address: string,
  network: BchNetwork,
): Promise<Contact> {
  const clean = name.trim().slice(0, 40);
  if (!clean) throw new RangeError("enter a name");
  const destination = parseDestination(address, network);
  const contact: Contact = {
    id: crypto.randomUUID(),
    name: clean,
    address: destination.address,
    network,
  };
  await chrome.storage.local.set({ [KEY]: [...(await loadContacts()), contact] });
  return contact;
}

export async function deleteContact(id: string): Promise<void> {
  await chrome.storage.local.set({ [KEY]: (await loadContacts()).filter((c) => c.id !== id) });
}
