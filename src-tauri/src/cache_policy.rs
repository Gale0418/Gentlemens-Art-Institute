#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PageSelection {
    /// Ordered nearest-first so useful pages enter RAM before distant pages.
    pub indices: Vec<usize>,
    pub selected_bytes: u64,
    pub whole_book: bool,
}

/// Selects encoded image pages by their actual ZIP entry sizes.
///
/// Small books fit entirely. Larger books expand from the current page in
/// reading-biased distance order until the live byte budget is exhausted.
/// A single oversized page is skipped and remains available through the
/// normal on-demand page protocol instead of blocking smaller neighbours.
pub(crate) fn select_pages_for_budget(
    page_sizes: &[u64],
    current_page: usize,
    budget_bytes: usize,
) -> PageSelection {
    if page_sizes.is_empty() || current_page >= page_sizes.len() || budget_bytes == 0 {
        return PageSelection {
            indices: Vec::new(),
            selected_bytes: 0,
            whole_book: false,
        };
    }

    let budget = budget_bytes as u64;
    let book_bytes = page_sizes
        .iter()
        .try_fold(0_u64, |total, size| total.checked_add(*size));
    if book_bytes.is_some_and(|total| total <= budget) {
        return PageSelection {
            indices: (0..page_sizes.len()).collect(),
            selected_bytes: book_bytes.unwrap_or(0),
            whole_book: true,
        };
    }

    let mut indices = Vec::new();
    let mut selected_bytes = 0_u64;
    for distance in 0..page_sizes.len() {
        let forward = current_page
            .checked_add(distance)
            .filter(|index| *index < page_sizes.len());
        let backward = (distance > 0)
            .then(|| current_page.checked_sub(distance))
            .flatten();

        for page_index in [forward, backward].into_iter().flatten() {
            let page_bytes = page_sizes[page_index];
            if page_bytes <= budget.saturating_sub(selected_bytes) {
                indices.push(page_index);
                selected_bytes = selected_bytes.saturating_add(page_bytes);
            }
        }
    }

    PageSelection {
        indices,
        selected_bytes,
        whole_book: false,
    }
}

#[cfg(test)]
mod tests {
    use super::select_pages_for_budget;

    const MIB: u64 = 1024 * 1024;

    #[test]
    fn small_book_uses_the_whole_budget_window() {
        let selection = select_pages_for_budget(&vec![MIB; 120], 60, 256 * MIB as usize);
        assert!(selection.whole_book);
        assert_eq!(selection.indices, (0..120).collect::<Vec<_>>());
        assert_eq!(selection.selected_bytes, 120 * MIB);
    }

    #[test]
    fn large_book_expands_nearest_first_until_bytes_are_full() {
        let selection = select_pages_for_budget(&vec![10 * MIB; 100], 50, 50 * MIB as usize);
        assert!(!selection.whole_book);
        assert_eq!(selection.indices, vec![50, 51, 49, 52, 48]);
        assert_eq!(selection.selected_bytes, 50 * MIB);
    }

    #[test]
    fn oversized_page_does_not_block_smaller_neighbours() {
        let selection =
            select_pages_for_budget(&[8 * MIB, 80 * MIB, 8 * MIB, 8 * MIB], 1, 24 * MIB as usize);
        assert_eq!(selection.indices, vec![2, 0, 3]);
        assert_eq!(selection.selected_bytes, 24 * MIB);
    }

    #[test]
    fn selection_stays_bounded_at_book_edges_and_zero_budget() {
        assert_eq!(
            select_pages_for_budget(&[4 * MIB; 4], 0, 8 * MIB as usize).indices,
            vec![0, 1]
        );
        assert!(select_pages_for_budget(&[MIB; 4], 0, 0).indices.is_empty());
        assert!(select_pages_for_budget(&[MIB; 4], 9, 8 * MIB as usize)
            .indices
            .is_empty());
    }
}
