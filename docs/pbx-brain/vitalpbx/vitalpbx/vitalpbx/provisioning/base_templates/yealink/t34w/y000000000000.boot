#!version:1.0.0.1
## The header above must appear as-is in the first line


##[$MODEL]include:config <xxx.cfg>
##[$MODEL,$MODEL]include:config "xxx.cfg"  
  
include:config "{{ $template }}"
     
overwrite_mode = 1
specific_model.excluded_mode=0
