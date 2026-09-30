-- Mantém os registros e as cartinhas antigas de Kisuke para auditoria, mas
-- remove esse destinatário das novas publicações e da interface pública.
UPDATE recipients
SET active = 0
WHERE slug = 'kisuke' AND kind = 'community';

UPDATE recipients
SET display_name = 'Staff', accent = 'mint', active = 1
WHERE slug = 'moderacao' AND kind = 'community';

UPDATE recipients
SET display_name = 'Toda a comunidade', active = 1
WHERE slug = 'comunidade' AND kind = 'community';
