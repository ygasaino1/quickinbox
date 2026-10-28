import type { AvailableDomain, EmailProviderKind, MailStatus } from '$lib/types';
import type { OutboundMailInput, OutboundMailResult } from './send-mail';

export type { EmailProviderKind };

export type ProviderDomain = {
	id: string;
	name: string;
	status: string;
	region?: string | null;
	sendingEnabled: boolean;
	receivingEnabled: boolean;
};

export type EmailProvider = {
	kind: EmailProviderKind;
	send(input: OutboundMailInput): Promise<OutboundMailResult>;
	listDomains(): Promise<ProviderDomain[]>;
	getDomain(id: string): Promise<ProviderDomain>;
};

export class ProviderError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = 'ProviderError';
		this.status = status;
		this.code = code;
	}
}

export function toAvailableDomain(domain: ProviderDomain, connected: boolean): AvailableDomain {
	return {
		id: domain.id,
		name: domain.name,
		status: domain.status,
		region: domain.region ?? null,
		can_send: domain.sendingEnabled,
		can_receive: domain.receivingEnabled,
		connected
	};
}

/** Outbound rows stay queued until Resend webhooks land; Cloudflare send() is already accepted. */
export function initialOutboundStatus(kind: EmailProviderKind): MailStatus {
	switch (kind) {
		case 'resend':
			return 'queued';
		case 'cloudflare':
			return 'sent';
		default: {
			const _never: never = kind;
			return _never;
		}
	}
}

export function providerLabel(kind: EmailProviderKind): string {
	switch (kind) {
		case 'resend':
			return 'Resend';
		case 'cloudflare':
			return 'Cloudflare Email';
		default: {
			const _never: never = kind;
			return _never;
		}
	}
}

/**
 * Which service delivers *inbound* mail. `EMAIL_PROVIDER` always picks the
 * outbound sender (and where domains are listed from); `EMAIL_INBOUND` lets
 * inbound come from the other one, e.g. Cloudflare Email Routing in and Resend
 * out. Unset means "same as EMAIL_PROVIDER". Returns null for an unknown value.
 */
export function resolveInboundKind(
	inbound: string | undefined | null,
	provider: string | undefined | null
): EmailProviderKind | null {
	const raw = (inbound?.trim() || provider?.trim() || 'resend').toLowerCase();
	return raw === 'resend' || raw === 'cloudflare' ? raw : null;
}

/**
 * When inbound comes from a different service than the sending provider, the
 * provider's own "can this domain receive?" answer is about the wrong service
 * (Resend reports receiving off for a domain that Cloudflare routes). Report
 * receiving from the inbound side instead: for Cloudflare, a domain receives
 * when it is listed in CLOUDFLARE_MAIL_DOMAINS.
 */
export function withInbound(
	provider: EmailProvider,
	inbound: EmailProviderKind,
	cloudflareDomains: string | undefined | null
): EmailProvider {
	if (inbound === provider.kind) return provider;

	const routed = new Set(parseMailDomains(cloudflareDomains));
	const adjust = (domain: ProviderDomain): ProviderDomain =>
		inbound === 'cloudflare'
			? { ...domain, receivingEnabled: routed.has(domain.name.toLowerCase()) }
			: domain;

	return {
		...provider,
		async listDomains() {
			return (await provider.listDomains()).map(adjust);
		},
		async getDomain(id: string) {
			return adjust(await provider.getDomain(id));
		}
	};
}

/** IANA reserved names used as dashboard placeholders; not real mail domains. */
const TEMPLATE_PLACEHOLDER_DOMAINS = new Set(['example.com', 'example.org', 'example.net']);

export function parseMailDomains(value: string | undefined | null): string[] {
	if (!value?.trim()) return [];
	const seen = new Set<string>();
	const domains: string[] = [];

	for (const part of value.split(',')) {
		const name = part.trim().toLowerCase().replace(/^@/, '');
		if (!name || seen.has(name) || TEMPLATE_PLACEHOLDER_DOMAINS.has(name)) continue;
		seen.add(name);
		domains.push(name);
	}

	return domains;
}
