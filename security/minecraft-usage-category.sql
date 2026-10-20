-- Correct only unknown Minecraft app categories; retain explicit custom categories.
-- No changes to durations, titles, device ownership or retention.
update public.usage
set category = 'Games'
where source = 'app'
  and (category is null or btrim(category) = '' or lower(btrim(category)) = 'uncategorized')
  and (
    lower(regexp_replace(name, '^.*[\\/]', '')) in ('minecraft.exe','minecraft.windows.exe','minecraftlauncher.exe')
    or (lower(regexp_replace(name, '^.*[\\/]', '')) in ('java.exe','javaw.exe')
        and title ~* '^\s*minecraft\M')
  );
