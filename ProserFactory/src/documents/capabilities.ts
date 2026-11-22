/** Runtime switch; release activation still requires the complete migration gates. */
export const documentAuthorityEnabled = () => process.env.DOCUMENT_AUTHORITY_ENABLED === 'true';
