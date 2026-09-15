'use client';

import type { NeighborhoodDto } from '@imob/contracts';
import { useId, useMemo, useState, type KeyboardEvent } from 'react';
import { normalizeText } from '@/lib/format';
import styles from './search.module.css';

interface Props {
  inputId: string;
  neighborhoods: NeighborhoodDto[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  /** Um bairro so (cadastro de imovel): escolher outro substitui o atual. */
  single?: boolean;
  invalid?: boolean;
  describedBy?: string;
}

/**
 * Seletor de bairros com autocompletar (padrao combobox da WAI-ARIA).
 *
 * Bairro e o unico filtro de localizacao da rede, entao este campo e a porta
 * de entrada da busca e do cadastro.
 *
 * Busca sem acento e sem caixa: "higienopolis" encontra "Jardim Higienópolis".
 * Corretor digita no celular, com pressa, e nao vai acertar o til.
 */
export function NeighborhoodPicker({
  inputId,
  neighborhoods,
  selectedIds,
  onChange,
  single = false,
  invalid,
  describedBy,
}: Props) {
  const baseId = useId();
  const listId = `${baseId}-list`;
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const byId = useMemo(() => new Map(neighborhoods.map((n) => [n.id, n])), [neighborhoods]);

  const options = useMemo(() => {
    const term = normalizeText(query);
    return neighborhoods
      .filter((n) => !selectedIds.includes(n.id))
      .filter((n) => term === '' || normalizeText(n.name).includes(term))
      .slice(0, 8);
  }, [neighborhoods, selectedIds, query]);

  const listVisible = open && options.length > 0;
  const noMatch = open && query.trim() !== '' && options.length === 0;
  const activeOption = listVisible ? options[Math.min(active, options.length - 1)] : undefined;

  function select(neighborhood: NeighborhoodDto) {
    onChange(single ? [neighborhood.id] : [...selectedIds, neighborhood.id]);
    setQuery('');
    setActive(0);
    // Fecha depois de escolher: reabrir com os bairros restantes cobria os
    // filtros de baixo. Digitar ou seta para baixo abre de novo.
    setOpen(false);
  }

  function remove(id: string) {
    onChange(selectedIds.filter((selected) => selected !== id));
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setOpen(true);
        setActive((index) => Math.min(index + 1, options.length - 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActive((index) => Math.max(index - 1, 0));
        break;
      case 'Enter':
        if (activeOption) {
          event.preventDefault();
          select(activeOption);
        }
        break;
      case 'Escape':
        setOpen(false);
        break;
      case 'Backspace':
        if (query === '' && selectedIds.length > 0) {
          remove(selectedIds[selectedIds.length - 1]!);
        }
        break;
    }
  }

  const placeholder = single && selectedIds.length > 0 ? 'Trocar o bairro' : 'Digite o bairro';

  return (
    <div className={styles.picker}>
      {selectedIds.length > 0 && (
        <ul className={styles.selected} aria-label={single ? 'Bairro escolhido' : 'Bairros escolhidos'}>
          {selectedIds.map((id) => {
            const neighborhood = byId.get(id);
            if (!neighborhood) return null;
            return (
              <li key={id} className={styles.selectedChip}>
                {neighborhood.name}
                <button
                  type="button"
                  className={styles.removeChip}
                  aria-label={`Remover ${neighborhood.name}`}
                  onClick={() => remove(id)}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className={styles.combo}>
        <input
          id={inputId}
          className="input"
          type="text"
          role="combobox"
          autoComplete="off"
          aria-autocomplete="list"
          aria-expanded={listVisible}
          aria-controls={listId}
          aria-activedescendant={activeOption ? `${baseId}-${activeOption.id}` : undefined}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={describedBy}
          placeholder={placeholder}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            setActive(0);
          }}
          onClick={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={handleKeyDown}
        />

        {listVisible && (
          <ul id={listId} role="listbox" className={styles.listbox}>
            {options.map((neighborhood, index) => (
              <li
                key={neighborhood.id}
                id={`${baseId}-${neighborhood.id}`}
                role="option"
                aria-selected={activeOption?.id === neighborhood.id}
                className={styles.option}
                // mousedown + preventDefault: escolhe antes do blur fechar a lista.
                onMouseDown={(event) => {
                  event.preventDefault();
                  select(neighborhood);
                }}
                onMouseEnter={() => setActive(index)}
              >
                {neighborhood.name}
              </li>
            ))}
          </ul>
        )}

        {noMatch && (
          <p className={styles.noMatch} role="status">
            Nenhum bairro com “{query.trim()}”.
          </p>
        )}
      </div>
    </div>
  );
}
