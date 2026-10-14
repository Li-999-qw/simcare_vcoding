def display_info(key, report):
    date=report['sheet']['collected']
    return dict(order_name=report['name'],result_group=report['name'],collected=date,sort_time=date)

def import_excerpt(report,positive_only=False):
    value=report.get('positive','') if positive_only else report['text']
    return ('【'+report['name']+' · '+report['sheet']['reported']+'】'+value) if value else ''
